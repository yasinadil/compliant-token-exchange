// app/lib/ledger-service.ts
// Internal ledger service for T Fiat balances and swaps

import { db } from "./db";
import { calculateSwapRate, getTokenUSDRate } from "./chainlink-service";
import { getProcessingFeeBps } from "./swap-security";
import crypto from "crypto";
import type { RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise";

/** Pool-or-connection handle — lets ledger primitives run inside a caller's
 *  transaction (e.g. webhook handler) or standalone (their own tx). */
type Executor = PoolConnection | typeof db;

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number };
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}

interface LedgerRow extends RowDataPacket {
  transaction_id: string;
  balance_after: string;
}

// Supported tokens (T Fiats + PLAT)
export const SUPPORTED_TOKENS = ["USDX", "GBPX", "EURX", "BRLX", "PLAT"] as const;
export type FiatToken = (typeof SUPPORTED_TOKENS)[number];

export interface UserBalance {
  token_symbol: string;
  balance: string;
  held: string;
}

export interface SwapQuote {
  fromToken: FiatToken;
  toToken: FiatToken;
  fromAmount: string;
  toAmount: string;
  rate: number;
  fromUSDRate: number;
  toUSDRate: number;
  expiresAt: Date;
  processingFeeBps: number;
  processingFeeUsd: string;
}

export interface SwapResult {
  transactionId: string;
  fromToken: FiatToken;
  toToken: FiatToken;
  fromAmount: string;
  toAmount: string;
  rate: number;
  newFromBalance: string;
  newToBalance: string;
  timestamp: Date;
}

interface BalanceRow extends RowDataPacket {
  balance: string;
  held?: string;
}

/**
 * Generate a unique transaction ID
 */
function generateTransactionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Validate token symbol
 */
function validateToken(token: string): asserts token is FiatToken {
  if (!SUPPORTED_TOKENS.includes(token as FiatToken)) {
    throw new Error(`Unsupported token: ${token}. Supported: ${SUPPORTED_TOKENS.join(", ")}`);
  }
}

/**
 * Get user balance for a specific token
 */
export async function getUserBalance(
  userId: string,
  tokenSymbol: string
): Promise<string> {
  validateToken(tokenSymbol);

  const [rows] = await db.execute<BalanceRow[]>(
    "SELECT balance FROM internal_balances WHERE user_id = ? AND token_symbol = ?",
    [userId, tokenSymbol]
  );

  if (rows.length === 0) {
    return "0";
  }

  return rows[0].balance;
}

/**
 * Get all balances for a user
 */
export async function getAllUserBalances(userId: string): Promise<UserBalance[]> {
  try {
    const [rows] = await db.execute<(RowDataPacket & { token_symbol: string; balance: string; held?: string })[]>(
      "SELECT token_symbol, balance, IFNULL(held, 0) AS held FROM internal_balances WHERE user_id = ?",
      [userId]
    );

    const balanceMap = new Map(rows.map((r) => [r.token_symbol, { balance: r.balance, held: r.held ?? "0" }]));

    return SUPPORTED_TOKENS.map((token) => ({
      token_symbol: token,
      balance: balanceMap.get(token)?.balance || "0",
      held: balanceMap.get(token)?.held || "0",
    }));
  } catch {
    // Fallback if 'held' column doesn't exist yet (migration not run)
    const [rows] = await db.execute<(RowDataPacket & { token_symbol: string; balance: string })[]>(
      "SELECT token_symbol, balance FROM internal_balances WHERE user_id = ?",
      [userId]
    );

    const balanceMap = new Map(rows.map((r) => [r.token_symbol, r.balance]));

    return SUPPORTED_TOKENS.map((token) => ({
      token_symbol: token,
      balance: balanceMap.get(token) || "0",
      held: "0",
    }));
  }
}

/**
 * Ensure user has a balance record for a token (creates with 0 if not exists)
 */
async function ensureBalanceRecord(
  connection: Executor,
  userId: string,
  tokenSymbol: string
): Promise<void> {
  await connection.execute(
    `INSERT IGNORE INTO internal_balances (user_id, token_symbol, balance) 
     VALUES (?, ?, 0)`,
    [userId, tokenSymbol]
  );
}

/**
 * Look up an existing ledger entry by idempotency key. Returns null if the
 * key has never been used. Runs on the caller's executor (pool OR connection)
 * so it observes uncommitted writes when called inside the same transaction.
 */
async function findLedgerByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string
): Promise<{ transactionId: string; balanceAfter: string } | null> {
  const [rows] = await executor.execute<LedgerRow[]>(
    "SELECT transaction_id, balance_after FROM ledger_transactions WHERE idempotency_key = ? LIMIT 1",
    [idempotencyKey]
  );
  if (rows.length === 0) return null;
  return { transactionId: rows[0].transaction_id, balanceAfter: rows[0].balance_after };
}

/**
 * Get a swap quote (calculate rates without executing)
 */
export async function getSwapQuote(
  fromToken: string,
  toToken: string,
  fromAmount: string
): Promise<SwapQuote> {
  validateToken(fromToken);
  validateToken(toToken);

  if (fromToken === toToken) {
    throw new Error("Cannot swap same token");
  }

  const amount = parseFloat(fromAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error("Invalid amount");
  }

  const rateData = await calculateSwapRate(fromToken, toToken);
  const grossToAmount = amount * rateData.rate;

  // Apply processing fee (deducted from the output amount)
  const feeBps = await getProcessingFeeBps();
  const feeInToToken = feeBps > 0 ? grossToAmount * feeBps / 10000 : 0;
  const netToAmount = grossToAmount - feeInToToken;

  // Convert fee to USD for display
  const feeUsd = feeInToToken * rateData.toUSDRate;

  return {
    fromToken: fromToken as FiatToken,
    toToken: toToken as FiatToken,
    fromAmount,
    toAmount: netToAmount.toFixed(18),
    rate: rateData.rate,
    fromUSDRate: rateData.fromUSDRate,
    toUSDRate: rateData.toUSDRate,
    expiresAt: new Date(Date.now() + 30000),
    processingFeeBps: feeBps,
    processingFeeUsd: feeUsd.toFixed(6),
  };
}

/**
 * Execute a swap between T Fiat tokens
 * This is an atomic database transaction with full audit logging
 */
export async function executeSwap(
  userId: string,
  fromToken: string,
  toToken: string,
  fromAmount: string,
  options?: {
    ipAddress?: string;
    userAgent?: string;
    notes?: string;
    /**
     * If true, the global processing fee (`getProcessingFeeBps`) is bypassed
     * for this swap. Used by the trade flow when sell orders auto-convert
     * USDX into the user's chosen fiat — that conversion is part of one
     * combined trade and shouldn't be charged again on top of the AMM fee.
     */
    skipProcessingFee?: boolean;
  }
): Promise<SwapResult> {
  validateToken(fromToken);
  validateToken(toToken);

  if (fromToken === toToken) {
    throw new Error("Cannot swap same token");
  }

  const amount = parseFloat(fromAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error("Invalid amount");
  }

  // Get a connection for transaction
  const connection = await db.getConnection();

  try {
    // Start transaction
    await connection.beginTransaction();

    // Ensure balance records exist
    await ensureBalanceRecord(connection, userId, fromToken);
    await ensureBalanceRecord(connection, userId, toToken);

    // Lock and get current balances (SELECT FOR UPDATE)
    const [fromBalanceRows] = await connection.execute<BalanceRow[]>(
      "SELECT balance FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, fromToken]
    );

    const [toBalanceRows] = await connection.execute<BalanceRow[]>(
      "SELECT balance FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, toToken]
    );

    const fromBalanceBefore = parseFloat(fromBalanceRows[0]?.balance || "0");
    const toBalanceBefore = parseFloat(toBalanceRows[0]?.balance || "0");

    // Check sufficient balance
    if (fromBalanceBefore < amount) {
      throw new Error(
        `Insufficient ${fromToken} balance. Have: ${fromBalanceBefore}, Need: ${amount}`
      );
    }

    // Get exchange rate from Chainlink
    const rateData = await calculateSwapRate(fromToken, toToken);
    const grossToAmount = amount * rateData.rate;

    // Apply processing fee (deducted from output)
    const feeBps = options?.skipProcessingFee ? 0 : await getProcessingFeeBps();
    const feeInToToken = feeBps > 0 ? grossToAmount * feeBps / 10000 : 0;
    const toAmount = grossToAmount - feeInToToken;

    // Calculate new balances
    const fromBalanceAfter = fromBalanceBefore - amount;
    const toBalanceAfter = toBalanceBefore + toAmount;

    // Update balances
    await connection.execute(
      "UPDATE internal_balances SET balance = ? WHERE user_id = ? AND token_symbol = ?",
      [fromBalanceAfter.toFixed(18), userId, fromToken]
    );

    await connection.execute(
      "UPDATE internal_balances SET balance = ? WHERE user_id = ? AND token_symbol = ?",
      [toBalanceAfter.toFixed(18), userId, toToken]
    );

    // Generate transaction ID
    const transactionId = generateTransactionId();

    // Safely extract oracle data (convert undefined to null for MySQL)
    // For Chainlink: feedAddress is the contract address
    // For Pyth: feedAddress is 0x0, but we store the roundId (which is the Pyth feed ID)
    const fromOracleSource = rateData.fromPriceData?.source ?? null;
    const toOracleSource = rateData.toPriceData?.source ?? null;
    
    // Use feedAddress for Chainlink, roundId (Pyth feed ID) for Pyth
    const fromFeedId = rateData.fromPriceData 
      ? (rateData.fromPriceData.source === "pyth" 
          ? rateData.fromPriceData.roundId 
          : rateData.fromPriceData.feedAddress)
      : null;
    const toFeedId = rateData.toPriceData
      ? (rateData.toPriceData.source === "pyth"
          ? rateData.toPriceData.roundId
          : rateData.toPriceData.feedAddress)
      : null;
    
    const blockNumber = rateData.fromPriceData?.blockNumber?.toString() ?? 
                        rateData.toPriceData?.blockNumber?.toString() ?? null;
    const oracleTimestamp = rateData.fromPriceData?.updatedAt ?? 
                            rateData.toPriceData?.updatedAt ?? new Date();

    // Log the swap transaction
    const [insertResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO swap_transactions (
        transaction_id, user_id,
        from_token, from_amount, from_balance_before, from_balance_after,
        to_token, to_amount, to_balance_before, to_balance_after,
        from_usd_rate, to_usd_rate, effective_rate,
        from_oracle_source, to_oracle_source,
        oracle_from_feed_id, oracle_to_feed_id,
        oracle_block_number, oracle_timestamp,
        status, ip_address, user_agent, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      [
        transactionId,
        userId,
        fromToken,
        amount.toFixed(18),
        fromBalanceBefore.toFixed(18),
        fromBalanceAfter.toFixed(18),
        toToken,
        toAmount.toFixed(18),
        toBalanceBefore.toFixed(18),
        toBalanceAfter.toFixed(18),
        rateData.fromUSDRate.toFixed(18),
        rateData.toUSDRate.toFixed(18),
        rateData.rate.toFixed(18),
        fromOracleSource,
        toOracleSource,
        fromFeedId,
        toFeedId,
        blockNumber,
        oracleTimestamp,
        options?.ipAddress ?? null,
        options?.userAgent ?? null,
        options?.notes ?? null,
      ]
    );

    // Get the swap transaction ID for ledger entries
    const swapId = insertResult.insertId;

    // Log ledger transactions (debit and credit)
    const debitTxId = generateTransactionId();
    const creditTxId = generateTransactionId();

    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, related_swap_id, notes
      ) VALUES (?, ?, 'swap_debit', ?, ?, ?, ?, ?, ?)`,
      [
        debitTxId,
        userId,
        fromToken,
        (-amount).toFixed(18),
        fromBalanceBefore.toFixed(18),
        fromBalanceAfter.toFixed(18),
        swapId,
        `Swap to ${toToken}`,
      ]
    );

    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, related_swap_id, notes
      ) VALUES (?, ?, 'swap_credit', ?, ?, ?, ?, ?, ?)`,
      [
        creditTxId,
        userId,
        toToken,
        toAmount.toFixed(18),
        toBalanceBefore.toFixed(18),
        toBalanceAfter.toFixed(18),
        swapId,
        `Swap from ${fromToken}`,
      ]
    );

    // Record collected fee if any (stored in USDX/USD equivalent)
    if (feeBps > 0 && feeInToToken > 0) {
      const grossUsd = grossToAmount * rateData.toUSDRate;
      const feeUsd = feeInToToken * rateData.toUSDRate;
      const netUsd = toAmount * rateData.toUSDRate;
      await connection.execute(
        `INSERT INTO collected_fees (
          order_id, user_id, order_type, fee_bps,
          gross_usdx, fee_usdx, net_usdx
        ) VALUES (?, ?, 'swap', ?, ?, ?, ?)`,
        [
          transactionId,
          userId,
          feeBps,
          grossUsd.toFixed(18),
          feeUsd.toFixed(18),
          netUsd.toFixed(18),
        ]
      );
    }

    // Commit transaction
    await connection.commit();

    return {
      transactionId,
      fromToken: fromToken as FiatToken,
      toToken: toToken as FiatToken,
      fromAmount: amount.toFixed(18),
      toAmount: toAmount.toFixed(18),
      rate: rateData.rate,
      newFromBalance: fromBalanceAfter.toFixed(18),
      newToBalance: toBalanceAfter.toFixed(18),
      timestamp: new Date(),
    };
  } catch (error) {
    // Rollback on any error
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Get swap transaction history for a user
 */
export async function getSwapHistory(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<any[]> {
  // Use query instead of execute for LIMIT/OFFSET compatibility
  // Values are sanitized (numbers only)
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM swap_transactions 
     WHERE user_id = ? 
     ORDER BY created_at DESC 
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );

  return rows;
}

/**
 * Get ledger transaction history for a user
 */
export async function getLedgerHistory(
  userId: string,
  tokenSymbol?: string,
  limit: number = 100,
  offset: number = 0
): Promise<any[]> {
  // Sanitize limit/offset
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);

  let query = `SELECT * FROM ledger_transactions WHERE user_id = ?`;
  const params: any[] = [userId];

  if (tokenSymbol) {
    validateToken(tokenSymbol);
    query += ` AND token_symbol = ?`;
    params.push(tokenSymbol);
  }

  query += ` ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const [rows] = await db.query<RowDataPacket[]>(query, params);

  return rows;
}

export type LedgerTransactionType =
  | "deposit"
  | "withdrawal"
  | "swap_debit"
  | "swap_credit"
  | "adjustment"
  | "stake_lock"
  | "stake_unlock"
  | "stake_reward"
  | "checkout_debit"
  | "checkout_refund"
  | "hold"
  | "hold_release";

export interface CreditBalanceOptions {
  type?: LedgerTransactionType;
  txHash?: string;
  notes?: string;
  createdBy?: string;
  /** Globally-unique key enforced by a UNIQUE index on
   *  `ledger_transactions.idempotency_key`. Retries with the same key
   *  are no-ops and return the original transactionId. Strongly recommended
   *  for any credit derived from an external event (Transak webhook,
   *  on-chain tx, client retry). */
  idempotencyKey?: string;
}

export type DebitBalanceOptions = CreditBalanceOptions;

/**
 * Credit tokens to a user's balance using an EXISTING transaction.
 * Caller is responsible for BEGIN / COMMIT / ROLLBACK. Used by callers that
 * need to tie the balance update to other rows in the same commit (e.g.
 * `processTransakWebhook` updating `onramp_orders` atomically with the credit).
 */
export async function creditBalanceWithConnection(
  connection: PoolConnection,
  userId: string,
  tokenSymbol: string,
  amount: string,
  options?: CreditBalanceOptions
): Promise<{ newBalance: string; transactionId: string; alreadyApplied: boolean }> {
  validateToken(tokenSymbol);

  const creditAmount = parseFloat(amount);
  if (isNaN(creditAmount) || creditAmount <= 0) {
    throw new Error("Invalid amount");
  }

  const ledgerType = options?.type ?? "deposit";
  const idempotencyKey = options?.idempotencyKey ?? null;

  // Fast-path: key already used → return prior result, do not re-apply.
  if (idempotencyKey) {
    const existing = await findLedgerByIdempotencyKey(connection, idempotencyKey);
    if (existing) {
      return {
        newBalance: existing.balanceAfter,
        transactionId: existing.transactionId,
        alreadyApplied: true,
      };
    }
  }

  await ensureBalanceRecord(connection, userId, tokenSymbol);

  const [balanceRows] = await connection.execute<BalanceRow[]>(
    "SELECT balance FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
    [userId, tokenSymbol]
  );

  const balanceBefore = parseFloat(balanceRows[0]?.balance || "0");
  const balanceAfter = balanceBefore + creditAmount;

  await connection.execute(
    "UPDATE internal_balances SET balance = ? WHERE user_id = ? AND token_symbol = ?",
    [balanceAfter.toFixed(18), userId, tokenSymbol]
  );

  const transactionId = generateTransactionId();

  try {
    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, related_tx_hash, notes, created_by,
        idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        userId,
        ledgerType,
        tokenSymbol,
        creditAmount.toFixed(18),
        balanceBefore.toFixed(18),
        balanceAfter.toFixed(18),
        options?.txHash || null,
        options?.notes || null,
        options?.createdBy || null,
        idempotencyKey,
      ]
    );
  } catch (err) {
    // Race: another committer just inserted with the same idempotency_key.
    // Re-read and return the existing entry; caller must NOT double-apply.
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findLedgerByIdempotencyKey(connection, idempotencyKey);
      if (existing) {
        return {
          newBalance: existing.balanceAfter,
          transactionId: existing.transactionId,
          alreadyApplied: true,
        };
      }
    }
    throw err;
  }

  return {
    newBalance: balanceAfter.toFixed(18),
    transactionId,
    alreadyApplied: false,
  };
}

/**
 * Credit tokens to a user's balance (for deposits, stake unlocks, stake rewards, etc.)
 */
export async function creditBalance(
  userId: string,
  tokenSymbol: string,
  amount: string,
  options?: CreditBalanceOptions
): Promise<{ newBalance: string; transactionId: string; alreadyApplied?: boolean }> {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    const result = await creditBalanceWithConnection(
      connection,
      userId,
      tokenSymbol,
      amount,
      options
    );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Debit tokens from a user's balance using an EXISTING transaction.
 */
export async function debitBalanceWithConnection(
  connection: PoolConnection,
  userId: string,
  tokenSymbol: string,
  amount: string,
  options?: DebitBalanceOptions
): Promise<{ newBalance: string; transactionId: string; alreadyApplied: boolean }> {
  validateToken(tokenSymbol);

  const debitAmount = parseFloat(amount);
  if (isNaN(debitAmount) || debitAmount <= 0) {
    throw new Error("Invalid amount");
  }

  const ledgerType = options?.type ?? "withdrawal";
  const idempotencyKey = options?.idempotencyKey ?? null;

  if (idempotencyKey) {
    const existing = await findLedgerByIdempotencyKey(connection, idempotencyKey);
    if (existing) {
      return {
        newBalance: existing.balanceAfter,
        transactionId: existing.transactionId,
        alreadyApplied: true,
      };
    }
  }

  const [balanceRows] = await connection.execute<BalanceRow[]>(
    "SELECT balance FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
    [userId, tokenSymbol]
  );

  const balanceBefore = parseFloat(balanceRows[0]?.balance || "0");

  if (balanceBefore < debitAmount) {
    throw new Error(`Insufficient ${tokenSymbol} balance`);
  }

  const balanceAfter = balanceBefore - debitAmount;

  await connection.execute(
    "UPDATE internal_balances SET balance = ? WHERE user_id = ? AND token_symbol = ?",
    [balanceAfter.toFixed(18), userId, tokenSymbol]
  );

  const transactionId = generateTransactionId();

  try {
    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, related_tx_hash, notes, created_by,
        idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        userId,
        ledgerType,
        tokenSymbol,
        (-debitAmount).toFixed(18),
        balanceBefore.toFixed(18),
        balanceAfter.toFixed(18),
        options?.txHash || null,
        options?.notes || null,
        options?.createdBy || null,
        idempotencyKey,
      ]
    );
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findLedgerByIdempotencyKey(connection, idempotencyKey);
      if (existing) {
        return {
          newBalance: existing.balanceAfter,
          transactionId: existing.transactionId,
          alreadyApplied: true,
        };
      }
    }
    throw err;
  }

  return {
    newBalance: balanceAfter.toFixed(18),
    transactionId,
    alreadyApplied: false,
  };
}

/**
 * Debit tokens from a user's balance (for withdrawals, stake locks, etc.)
 */
export async function debitBalance(
  userId: string,
  tokenSymbol: string,
  amount: string,
  options?: DebitBalanceOptions
): Promise<{ newBalance: string; transactionId: string; alreadyApplied?: boolean }> {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    const result = await debitBalanceWithConnection(
      connection,
      userId,
      tokenSymbol,
      amount,
      options
    );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Hold funds: move amount from available balance to held.
 * Used when a swap requires admin approval so the user cannot double-spend.
 */
export async function holdFunds(
  userId: string,
  tokenSymbol: string,
  amount: string,
  notes?: string
): Promise<{ transactionId: string }> {
  validateToken(tokenSymbol);

  const holdAmount = parseFloat(amount);
  if (isNaN(holdAmount) || holdAmount <= 0) {
    throw new Error("Invalid hold amount");
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    await ensureBalanceRecord(connection, userId, tokenSymbol);

    const [rows] = await connection.execute<BalanceRow[]>(
      "SELECT balance, held FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, tokenSymbol]
    );

    const balanceBefore = parseFloat(rows[0]?.balance || "0");
    if (balanceBefore < holdAmount) {
      throw new Error(`Insufficient ${tokenSymbol} balance. Have: ${balanceBefore}, Need: ${holdAmount}`);
    }

    const balanceAfter = balanceBefore - holdAmount;
    const heldBefore = parseFloat(rows[0]?.held || "0");
    const heldAfter = heldBefore + holdAmount;

    await connection.execute(
      "UPDATE internal_balances SET balance = ?, held = ? WHERE user_id = ? AND token_symbol = ?",
      [balanceAfter.toFixed(18), heldAfter.toFixed(18), userId, tokenSymbol]
    );

    const transactionId = generateTransactionId();

    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, notes, created_by
      ) VALUES (?, ?, 'hold', ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        userId,
        tokenSymbol,
        (-holdAmount).toFixed(18),
        balanceBefore.toFixed(18),
        balanceAfter.toFixed(18),
        notes || `Hold for pending approval`,
        "system",
      ]
    );

    await connection.commit();
    return { transactionId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Release a hold: move amount from held back to available balance.
 * Used when an admin rejects a pending approval or it expires.
 */
export async function releaseHold(
  userId: string,
  tokenSymbol: string,
  amount: string,
  notes?: string
): Promise<{ transactionId: string }> {
  validateToken(tokenSymbol);

  const releaseAmount = parseFloat(amount);
  if (isNaN(releaseAmount) || releaseAmount <= 0) {
    throw new Error("Invalid release amount");
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute<BalanceRow[]>(
      "SELECT balance, held FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, tokenSymbol]
    );

    const heldBefore = parseFloat(rows[0]?.held || "0");
    if (heldBefore < releaseAmount) {
      throw new Error(`Insufficient held ${tokenSymbol}. Held: ${heldBefore}, Releasing: ${releaseAmount}`);
    }

    const balanceBefore = parseFloat(rows[0]?.balance || "0");
    const balanceAfter = balanceBefore + releaseAmount;
    const heldAfter = heldBefore - releaseAmount;

    await connection.execute(
      "UPDATE internal_balances SET balance = ?, held = ? WHERE user_id = ? AND token_symbol = ?",
      [balanceAfter.toFixed(18), heldAfter.toFixed(18), userId, tokenSymbol]
    );

    const transactionId = generateTransactionId();

    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, notes, created_by
      ) VALUES (?, ?, 'hold_release', ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        userId,
        tokenSymbol,
        releaseAmount.toFixed(18),
        balanceBefore.toFixed(18),
        balanceAfter.toFixed(18),
        notes || `Hold released`,
        "system",
      ]
    );

    await connection.commit();
    return { transactionId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Execute a swap sourcing from held funds (not available balance).
 * Used when an admin approves a previously held pending swap.
 */
export async function executeSwapFromHold(
  userId: string,
  fromToken: string,
  toToken: string,
  fromAmount: string,
  options?: {
    ipAddress?: string;
    userAgent?: string;
    notes?: string;
  }
): Promise<SwapResult> {
  validateToken(fromToken);
  validateToken(toToken);

  if (fromToken === toToken) {
    throw new Error("Cannot swap same token");
  }

  const amount = parseFloat(fromAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error("Invalid amount");
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    await ensureBalanceRecord(connection, userId, fromToken);
    await ensureBalanceRecord(connection, userId, toToken);

    const [fromRows] = await connection.execute<BalanceRow[]>(
      "SELECT balance, held FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, fromToken]
    );

    const [toRows] = await connection.execute<BalanceRow[]>(
      "SELECT balance, held FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, toToken]
    );

    const fromHeldBefore = parseFloat(fromRows[0]?.held || "0");
    if (fromHeldBefore < amount) {
      throw new Error(`Insufficient held ${fromToken}. Held: ${fromHeldBefore}, Need: ${amount}`);
    }

    const fromBalanceBefore = parseFloat(fromRows[0]?.balance || "0");
    const toBalanceBefore = parseFloat(toRows[0]?.balance || "0");

    const rateData = await calculateSwapRate(fromToken, toToken);
    const grossToAmount = amount * rateData.rate;

    const feeBps = await getProcessingFeeBps();
    const feeInToToken = feeBps > 0 ? grossToAmount * feeBps / 10000 : 0;
    const toAmount = grossToAmount - feeInToToken;

    const fromHeldAfter = fromHeldBefore - amount;
    const toBalanceAfter = toBalanceBefore + toAmount;

    await connection.execute(
      "UPDATE internal_balances SET held = ? WHERE user_id = ? AND token_symbol = ?",
      [fromHeldAfter.toFixed(18), userId, fromToken]
    );

    await connection.execute(
      "UPDATE internal_balances SET balance = ? WHERE user_id = ? AND token_symbol = ?",
      [toBalanceAfter.toFixed(18), userId, toToken]
    );

    const transactionId = generateTransactionId();

    const fromOracleSource = rateData.fromPriceData?.source ?? null;
    const toOracleSource = rateData.toPriceData?.source ?? null;
    const fromFeedId = rateData.fromPriceData
      ? (rateData.fromPriceData.source === "pyth"
          ? rateData.fromPriceData.roundId
          : rateData.fromPriceData.feedAddress)
      : null;
    const toFeedId = rateData.toPriceData
      ? (rateData.toPriceData.source === "pyth"
          ? rateData.toPriceData.roundId
          : rateData.toPriceData.feedAddress)
      : null;
    const blockNumber = rateData.fromPriceData?.blockNumber?.toString() ??
                        rateData.toPriceData?.blockNumber?.toString() ?? null;
    const oracleTimestamp = rateData.fromPriceData?.updatedAt ??
                            rateData.toPriceData?.updatedAt ?? new Date();

    const [insertResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO swap_transactions (
        transaction_id, user_id,
        from_token, from_amount, from_balance_before, from_balance_after,
        to_token, to_amount, to_balance_before, to_balance_after,
        from_usd_rate, to_usd_rate, effective_rate,
        from_oracle_source, to_oracle_source,
        oracle_from_feed_id, oracle_to_feed_id,
        oracle_block_number, oracle_timestamp,
        status, ip_address, user_agent, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      [
        transactionId,
        userId,
        fromToken,
        amount.toFixed(18),
        fromBalanceBefore.toFixed(18),
        fromBalanceBefore.toFixed(18),
        toToken,
        toAmount.toFixed(18),
        toBalanceBefore.toFixed(18),
        toBalanceAfter.toFixed(18),
        rateData.fromUSDRate.toFixed(18),
        rateData.toUSDRate.toFixed(18),
        rateData.rate.toFixed(18),
        fromOracleSource,
        toOracleSource,
        fromFeedId,
        toFeedId,
        blockNumber,
        oracleTimestamp,
        options?.ipAddress ?? null,
        options?.userAgent ?? null,
        options?.notes ?? null,
      ]
    );

    const swapId = insertResult.insertId;
    const debitTxId = generateTransactionId();
    const creditTxId = generateTransactionId();

    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, related_swap_id, notes
      ) VALUES (?, ?, 'swap_debit', ?, ?, ?, ?, ?, ?)`,
      [
        debitTxId,
        userId,
        fromToken,
        (-amount).toFixed(18),
        fromBalanceBefore.toFixed(18),
        fromBalanceBefore.toFixed(18),
        swapId,
        `Swap to ${toToken} (from held funds)`,
      ]
    );

    await connection.execute(
      `INSERT INTO ledger_transactions (
        transaction_id, user_id, type, token_symbol, amount,
        balance_before, balance_after, related_swap_id, notes
      ) VALUES (?, ?, 'swap_credit', ?, ?, ?, ?, ?, ?)`,
      [
        creditTxId,
        userId,
        toToken,
        toAmount.toFixed(18),
        toBalanceBefore.toFixed(18),
        toBalanceAfter.toFixed(18),
        swapId,
        `Swap from ${fromToken} (from held funds)`,
      ]
    );

    if (feeBps > 0 && feeInToToken > 0) {
      const grossUsd = grossToAmount * rateData.toUSDRate;
      const feeUsd = feeInToToken * rateData.toUSDRate;
      const netUsd = toAmount * rateData.toUSDRate;
      await connection.execute(
        `INSERT INTO collected_fees (
          order_id, user_id, order_type, fee_bps,
          gross_usdx, fee_usdx, net_usdx
        ) VALUES (?, ?, 'swap', ?, ?, ?, ?)`,
        [transactionId, userId, feeBps, grossUsd.toFixed(18), feeUsd.toFixed(18), netUsd.toFixed(18)]
      );
    }

    await connection.commit();

    return {
      transactionId,
      fromToken: fromToken as FiatToken,
      toToken: toToken as FiatToken,
      fromAmount: amount.toFixed(18),
      toAmount: toAmount.toFixed(18),
      rate: rateData.rate,
      newFromBalance: fromBalanceBefore.toFixed(18),
      newToBalance: toBalanceAfter.toFixed(18),
      timestamp: new Date(),
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

