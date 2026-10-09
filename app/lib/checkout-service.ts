// app/lib/checkout-service.ts
// Core service for the external Checkout API (server-to-server balance charges)

import { db, adminDb } from "./db";
import {
  debitBalanceWithConnection,
  creditBalanceWithConnection,
  getUserBalance,
} from "./ledger-service";
import crypto from "crypto";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

/** MySQL duplicate-key (unique constraint) detection. */
function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number };
  return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}

// ============================================================================
// TYPES
// ============================================================================

export interface CheckoutApiKey {
  id: number;
  key_id: string;
  name: string;
  permissions: string[];
  is_active: boolean;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}

export interface CheckoutCharge {
  id: string;
  user_id: string;
  amount: string;
  currency: string;
  status: "completed" | "refunded" | "partially_refunded";
  description: string | null;
  reference: string;
  ledger_transaction_id: string;
  refunded_amount: string;
  created_at: string;
}

export interface CheckoutRefund {
  id: string;
  charge_id: string;
  amount: string;
  reason: string | null;
  status: "completed" | "failed";
  ledger_transaction_id: string | null;
  created_at: string;
}

type CheckoutPermission = "charge" | "refund" | "balance";

const ALLOWED_CURRENCIES = ["PLAT"] as const;

// ============================================================================
// API KEY MANAGEMENT
// ============================================================================

function generateKeyId(): string {
  return `exch_key_${crypto.randomBytes(6).toString("hex")}`;
}

function generateSecret(): string {
  return `exch_sec_${crypto.randomBytes(32).toString("hex")}`;
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function generateChargeId(): string {
  return `chg_${crypto.randomBytes(16).toString("hex")}`;
}

function generateRefundId(): string {
  return `ref_${crypto.randomBytes(16).toString("hex")}`;
}

export async function createApiKey(
  name: string,
  createdBy: string,
  permissions: CheckoutPermission[] = ["charge", "refund", "balance"]
): Promise<{ keyId: string; secret: string }> {
  const keyId = generateKeyId();
  const secret = generateSecret();
  const secretHash = hashSecret(secret);

  await adminDb.execute<ResultSetHeader>(
    `INSERT INTO checkout_api_keys (key_id, secret_hash, name, permissions, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [keyId, secretHash, name, JSON.stringify(permissions), createdBy]
  );

  return { keyId, secret };
}

export async function validateApiKey(
  keyId: string,
  secret: string,
  requiredPermission?: CheckoutPermission
): Promise<{ valid: true; apiKeyId: number } | { valid: false; error: string }> {
  const [rows] = await db.execute<(RowDataPacket & {
    id: number;
    secret_hash: string;
    permissions: string;
    is_active: boolean;
  })[]>(
    "SELECT id, secret_hash, permissions, is_active FROM checkout_api_keys WHERE key_id = ?",
    [keyId]
  );

  if (rows.length === 0) {
    return { valid: false, error: "Invalid API key" };
  }

  const row = rows[0];

  if (!row.is_active) {
    return { valid: false, error: "API key has been revoked" };
  }

  const expectedHash = row.secret_hash;
  const providedHash = hashSecret(secret);

  if (!crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(providedHash))) {
    return { valid: false, error: "Invalid API secret" };
  }

  if (requiredPermission) {
    let permissions: string[];
    try {
      permissions = typeof row.permissions === "string"
        ? JSON.parse(row.permissions)
        : row.permissions;
    } catch {
      permissions = [];
    }

    if (!permissions.includes(requiredPermission)) {
      return { valid: false, error: `API key lacks '${requiredPermission}' permission` };
    }
  }

  return { valid: true, apiKeyId: row.id };
}

export async function listApiKeys(): Promise<CheckoutApiKey[]> {
  const [rows] = await adminDb.execute<(RowDataPacket & CheckoutApiKey & { permissions: string })[]>(
    `SELECT id, key_id, name, permissions, is_active, created_by, created_at, revoked_at
     FROM checkout_api_keys ORDER BY created_at DESC`
  );

  return rows.map((r) => ({
    ...r,
    permissions: typeof r.permissions === "string" ? JSON.parse(r.permissions) : r.permissions,
  }));
}

export async function revokeApiKey(keyId: string): Promise<boolean> {
  const [result] = await adminDb.execute<ResultSetHeader>(
    "UPDATE checkout_api_keys SET is_active = FALSE, revoked_at = NOW() WHERE key_id = ? AND is_active = TRUE",
    [keyId]
  );
  return result.affectedRows > 0;
}

// ============================================================================
// CHARGES
// ============================================================================

interface CreateChargeParams {
  apiKeyId: number;
  userId: string;
  amount: string;
  currency: string;
  description?: string;
  reference: string;
  idempotencyKey: string;
}

export async function createCharge(
  params: CreateChargeParams
): Promise<
  | { success: true; charge: CheckoutCharge }
  | { success: false; error: string; status: number }
> {
  const { apiKeyId, userId, amount, currency, description, reference, idempotencyKey } = params;

  if (!ALLOWED_CURRENCIES.includes(currency as typeof ALLOWED_CURRENCIES[number])) {
    return { success: false, error: `Unsupported currency: ${currency}. Allowed: ${ALLOWED_CURRENCIES.join(", ")}`, status: 400 };
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return { success: false, error: "Amount must be a positive number", status: 400 };
  }

  // The debit and the charge-record insert MUST be one atomic unit, or a
  // partial failure could leave the user debited with no charge row (and a
  // retry would debit again). We also serialize concurrent same-user charges
  // by locking the balance row first, so the idempotency check + debit + insert
  // cannot interleave and double-charge. The `(api_key_id, idempotency_key)`
  // unique index is the final backstop: a duplicate insert is caught and the
  // original charge returned instead of applying a second debit.
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the user's balance row (if it exists) to serialize concurrent
    // charges for this user+currency. A brand-new user with no row would fail
    // the debit as insufficient funds anyway, so nothing to lock there.
    await connection.execute(
      "SELECT balance FROM internal_balances WHERE user_id = ? AND token_symbol = ? FOR UPDATE",
      [userId, currency]
    );

    // Idempotency check inside the lock: a committed prior charge is visible.
    const existing = await getChargeByIdempotency(connection, apiKeyId, idempotencyKey);
    if (existing) {
      await connection.commit();
      if (
        existing.user_id !== userId ||
        parseFloat(existing.amount).toFixed(18) !== parsedAmount.toFixed(18) ||
        existing.currency !== currency ||
        existing.reference !== reference
      ) {
        return {
          success: false,
          error: "Idempotency key already used with different parameters",
          status: 409,
        };
      }
      return { success: true, charge: existing };
    }

    // Debit in the SAME transaction. Namespaced ledger idempotency key adds a
    // second layer of exactly-once at the ledger level.
    let ledgerResult: { newBalance: string; transactionId: string };
    try {
      ledgerResult = await debitBalanceWithConnection(
        connection,
        userId,
        currency,
        parsedAmount.toFixed(18),
        {
          type: "checkout_debit",
          notes: `Checkout charge: ${description || reference}`,
          createdBy: `api_key:${apiKeyId}`,
          idempotencyKey: `checkout:${apiKeyId}:${idempotencyKey}`,
        }
      );
    } catch (error) {
      await connection.rollback();
      const msg = error instanceof Error ? error.message : "Balance debit failed";
      if (msg.includes("Insufficient")) {
        return { success: false, error: msg, status: 402 };
      }
      return { success: false, error: msg, status: 500 };
    }

    const chargeId = generateChargeId();
    try {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO checkout_charges
           (charge_id, api_key_id, user_id, amount, currency, status, description, reference, idempotency_key, ledger_transaction_id)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
        [chargeId, apiKeyId, userId, parsedAmount.toFixed(18), currency, description || null, reference, idempotencyKey, ledgerResult.transactionId]
      );
    } catch (error) {
      // Concurrent request already committed this charge. Roll back our debit
      // (undone, so no double charge) and return the winning charge.
      if (isDuplicateKeyError(error)) {
        await connection.rollback();
        const winner = await getChargeByIdempotency(db, apiKeyId, idempotencyKey);
        if (winner) return { success: true, charge: winner };
      }
      await connection.rollback();
      throw error;
    }

    await connection.commit();

    return {
      success: true,
      charge: {
        id: chargeId,
        user_id: userId,
        amount: parsedAmount.toFixed(18),
        currency,
        status: "completed",
        description: description || null,
        reference,
        ledger_transaction_id: ledgerResult.transactionId,
        refunded_amount: "0.000000000000000000",
        created_at: new Date().toISOString(),
      },
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* already rolled back / committed */
    }
    const msg = error instanceof Error ? error.message : "Charge failed";
    return { success: false, error: msg, status: 500 };
  } finally {
    connection.release();
  }
}

/** Read a charge by its (api_key_id, idempotency_key) using any executor. */
async function getChargeByIdempotency(
  executor: typeof db | import("mysql2/promise").PoolConnection,
  apiKeyId: number,
  idempotencyKey: string
): Promise<CheckoutCharge | null> {
  const [rows] = await executor.execute<(RowDataPacket & {
    charge_id: string;
    user_id: string;
    amount: string;
    currency: string;
    status: string;
    description: string | null;
    reference: string;
    ledger_transaction_id: string;
    refunded_amount: string;
    created_at: string;
  })[]>(
    `SELECT charge_id, user_id, amount, currency, status, description, reference,
            ledger_transaction_id, refunded_amount, created_at
     FROM checkout_charges
     WHERE api_key_id = ? AND idempotency_key = ?`,
    [apiKeyId, idempotencyKey]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.charge_id,
    user_id: r.user_id,
    amount: parseFloat(r.amount).toFixed(18),
    currency: r.currency,
    status: r.status as CheckoutCharge["status"],
    description: r.description,
    reference: r.reference,
    ledger_transaction_id: r.ledger_transaction_id,
    refunded_amount: parseFloat(r.refunded_amount).toFixed(18),
    created_at: r.created_at,
  };
}

export async function getCharge(
  chargeId: string,
  apiKeyId: number
): Promise<CheckoutCharge | null> {
  const [rows] = await db.execute<(RowDataPacket & {
    charge_id: string;
    user_id: string;
    amount: string;
    currency: string;
    status: string;
    description: string | null;
    reference: string;
    ledger_transaction_id: string;
    refunded_amount: string;
    created_at: string;
  })[]>(
    `SELECT charge_id, user_id, amount, currency, status, description, reference,
            ledger_transaction_id, refunded_amount, created_at
     FROM checkout_charges WHERE charge_id = ? AND api_key_id = ?`,
    [chargeId, apiKeyId]
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    id: r.charge_id,
    user_id: r.user_id,
    amount: parseFloat(r.amount).toFixed(18),
    currency: r.currency,
    status: r.status as CheckoutCharge["status"],
    description: r.description,
    reference: r.reference,
    ledger_transaction_id: r.ledger_transaction_id,
    refunded_amount: parseFloat(r.refunded_amount).toFixed(18),
    created_at: r.created_at,
  };
}

interface ListChargesOptions {
  apiKeyId: number;
  userId?: string;
  reference?: string;
  limit?: number;
  offset?: number;
}

export async function listCharges(opts: ListChargesOptions): Promise<CheckoutCharge[]> {
  const { apiKeyId, userId, reference } = opts;
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
  const offset = Math.max(0, Number(opts.offset) || 0);

  let query = "SELECT charge_id, user_id, amount, currency, status, description, reference, ledger_transaction_id, refunded_amount, created_at FROM checkout_charges WHERE api_key_id = ?";
  const params: (string | number)[] = [apiKeyId];

  if (userId) {
    query += " AND user_id = ?";
    params.push(userId);
  }
  if (reference) {
    query += " AND reference = ?";
    params.push(reference);
  }

  query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const [rows] = await db.query<(RowDataPacket & {
    charge_id: string;
    user_id: string;
    amount: string;
    currency: string;
    status: string;
    description: string | null;
    reference: string;
    ledger_transaction_id: string;
    refunded_amount: string;
    created_at: string;
  })[]>(query, params);

  return rows.map((r) => ({
    id: r.charge_id,
    user_id: r.user_id,
    amount: parseFloat(r.amount).toFixed(18),
    currency: r.currency,
    status: r.status as CheckoutCharge["status"],
    description: r.description,
    reference: r.reference,
    ledger_transaction_id: r.ledger_transaction_id,
    refunded_amount: parseFloat(r.refunded_amount).toFixed(18),
    created_at: r.created_at,
  }));
}

// ============================================================================
// REFUNDS
// ============================================================================

interface CreateRefundParams {
  apiKeyId: number;
  chargeId: string;
  amount?: string;
  reason?: string;
  /** Unique per refund attempt (per API key). Makes retries exactly-once. */
  idempotencyKey: string;
}

export async function createRefund(
  params: CreateRefundParams
): Promise<
  | { success: true; refund: CheckoutRefund }
  | { success: false; error: string; status: number }
> {
  const { apiKeyId, chargeId, reason, idempotencyKey } = params;

  // Whole refund runs in one transaction. We lock the charge row FOR UPDATE so
  // concurrent refunds on the same charge serialize — otherwise two partial
  // refunds could both read the same `refunded_amount` and over-credit. The
  // `(api_key_id, idempotency_key)` unique index makes a retried refund a
  // no-op that returns the original result.
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the charge row; this is also our read of current refunded_amount.
    const [chargeRows] = await connection.execute<(RowDataPacket & {
      id: number;
      charge_id: string;
      api_key_id: number;
      user_id: string;
      amount: string;
      currency: string;
      status: string;
      refunded_amount: string;
    })[]>(
      "SELECT id, charge_id, api_key_id, user_id, amount, currency, status, refunded_amount FROM checkout_charges WHERE charge_id = ? AND api_key_id = ? FOR UPDATE",
      [chargeId, apiKeyId]
    );

    if (chargeRows.length === 0) {
      await connection.rollback();
      return { success: false, error: "Charge not found", status: 404 };
    }

    // Idempotency check inside the charge lock.
    const existingRefund = await getRefundByIdempotency(connection, apiKeyId, idempotencyKey);
    if (existingRefund) {
      await connection.commit();
      if (existingRefund.charge_id !== chargeId) {
        return {
          success: false,
          error: "Idempotency key already used for a different charge",
          status: 409,
        };
      }
      return { success: true, refund: existingRefund };
    }

    const charge = chargeRows[0];
    const chargeAmount = parseFloat(charge.amount);
    const alreadyRefunded = parseFloat(charge.refunded_amount);
    const maxRefundable = chargeAmount - alreadyRefunded;

    if (maxRefundable <= 0) {
      await connection.rollback();
      return { success: false, error: "Charge has already been fully refunded", status: 400 };
    }

    let refundAmount: number;
    if (params.amount) {
      refundAmount = parseFloat(params.amount);
      if (isNaN(refundAmount) || refundAmount <= 0) {
        await connection.rollback();
        return { success: false, error: "Refund amount must be a positive number", status: 400 };
      }
      if (refundAmount > maxRefundable) {
        await connection.rollback();
        return {
          success: false,
          error: `Refund amount (${refundAmount}) exceeds refundable balance (${maxRefundable.toFixed(18)})`,
          status: 400,
        };
      }
    } else {
      refundAmount = maxRefundable;
    }

    // Credit the balance back in the SAME transaction.
    let ledgerResult: { newBalance: string; transactionId: string };
    try {
      ledgerResult = await creditBalanceWithConnection(
        connection,
        charge.user_id,
        charge.currency,
        refundAmount.toFixed(18),
        {
          type: "checkout_refund",
          notes: `Refund for charge ${chargeId}${reason ? `: ${reason}` : ""}`,
          createdBy: `api_key:${apiKeyId}`,
          idempotencyKey: `checkout_refund:${apiKeyId}:${idempotencyKey}`,
        }
      );
    } catch (error) {
      await connection.rollback();
      const msg = error instanceof Error ? error.message : "Balance credit failed";
      return { success: false, error: msg, status: 500 };
    }

    const refundId = generateRefundId();
    const newRefundedTotal = alreadyRefunded + refundAmount;
    const newStatus = newRefundedTotal >= chargeAmount ? "refunded" : "partially_refunded";

    try {
      await connection.execute<ResultSetHeader>(
        `INSERT INTO checkout_refunds (refund_id, charge_id, api_key_id, amount, reason, idempotency_key, status, ledger_transaction_id)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
        [refundId, chargeId, apiKeyId, refundAmount.toFixed(18), reason || null, idempotencyKey, ledgerResult.transactionId]
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        await connection.rollback();
        const winner = await getRefundByIdempotency(db, apiKeyId, idempotencyKey);
        if (winner) return { success: true, refund: winner };
      }
      await connection.rollback();
      throw error;
    }

    await connection.execute(
      "UPDATE checkout_charges SET refunded_amount = ?, status = ? WHERE charge_id = ?",
      [newRefundedTotal.toFixed(18), newStatus, chargeId]
    );

    await connection.commit();

    return {
      success: true,
      refund: {
        id: refundId,
        charge_id: chargeId,
        amount: refundAmount.toFixed(18),
        reason: reason || null,
        status: "completed",
        ledger_transaction_id: ledgerResult.transactionId,
        created_at: new Date().toISOString(),
      },
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* already settled */
    }
    const msg = error instanceof Error ? error.message : "Refund failed";
    return { success: false, error: msg, status: 500 };
  } finally {
    connection.release();
  }
}

/** Read a refund by its (api_key_id, idempotency_key) using any executor. */
async function getRefundByIdempotency(
  executor: typeof db | import("mysql2/promise").PoolConnection,
  apiKeyId: number,
  idempotencyKey: string
): Promise<CheckoutRefund | null> {
  const [rows] = await executor.execute<(RowDataPacket & {
    refund_id: string;
    charge_id: string;
    amount: string;
    reason: string | null;
    status: string;
    ledger_transaction_id: string | null;
    created_at: string;
  })[]>(
    `SELECT refund_id, charge_id, amount, reason, status, ledger_transaction_id, created_at
     FROM checkout_refunds
     WHERE api_key_id = ? AND idempotency_key = ?`,
    [apiKeyId, idempotencyKey]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.refund_id,
    charge_id: r.charge_id,
    amount: parseFloat(r.amount).toFixed(18),
    reason: r.reason,
    status: r.status as CheckoutRefund["status"],
    ledger_transaction_id: r.ledger_transaction_id,
    created_at: r.created_at,
  };
}

// ============================================================================
// BALANCE
// ============================================================================

export async function getCheckoutBalance(
  userId: string,
  currency: string = "PLAT"
): Promise<{ user_id: string; currency: string; available: string }> {
  if (!ALLOWED_CURRENCIES.includes(currency as typeof ALLOWED_CURRENCIES[number])) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  const balance = await getUserBalance(userId, currency);
  return { user_id: userId, currency, available: balance };
}
