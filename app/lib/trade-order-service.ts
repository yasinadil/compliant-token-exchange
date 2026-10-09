// app/lib/trade-order-service.ts
// Order lifecycle management for fiat-to-PLAT buy/sell

import crypto from "crypto";
import { db, adminDb } from "./db";
import { creditBalance, debitBalance, getUserBalance, executeSwap } from "./ledger-service";
import { quoteSwap, getPoolInfo } from "./amm-service";
import { getTokenUSDRate } from "./chainlink-service";
import {
  executeOperatorBuy,
  executeOperatorSell,
  getOperatorBalances,
  getOperatorSmartAccountAddress,
  getMaxSlippageBps,
} from "./operator-service";
import { type FiatCurrency } from "./payment-service";
import { getTransakPriceQuote } from "./transak-service";
import { TRANSAK_MIN_PER_CURRENCY, estimateOnRampFee } from "./transak-limits";
import { getSmartAccountAddressForUser } from "./wallet-service";
import { redactPrivateKey } from "./platform-wallet-service";
import { formatTradeExecutionError } from "./trade-errors";
import { parseUnits } from "viem";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

// ============================================================================
// TYPES
// ============================================================================

export type OrderType = "buy" | "sell" | "convert";
export type OrderStatus =
  | "pending_payment"
  | "payment_received"
  | "executing"
  | "completed"
  | "slippage_fallback"
  | "price_changed"
  | "insufficient_balance"
  | "failed"
  | "cancelled";

export interface TradeOrder {
  id: number;
  order_id: string;
  user_id: string;
  order_type: OrderType;
  status: OrderStatus;
  fiat_currency: FiatCurrency;
  payout_currency: FiatCurrency;
  fiat_amount: string;
  fiat_to_tusd_rate: string;
  tusd_amount: string;
  payout_amount: string;
  tglobal_amount: string;
  amm_quote_price: string | null;
  executed_price: string | null;
  slippage_bps: number;
  max_slippage_bps: number;
  operator_tx_hash: string | null;
  operator_smart_account: string | null;
  payment_reference: string | null;
  payment_provider: string;
  credit_transaction_id: string | null;
  payout_swap_transaction_id: string | null;
  debit_transaction_id: string | null;
  balance_token: string | null;
  balance_amount: string;
  balance_tusd_equivalent: string;
  charged_fiat_amount: string;
  balance_debit_tx_id: string | null;
  balance_swap_tx_id: string | null;
  onramp_order_id: string | null;
  failure_reason: string | null;
  // Convert order fields (NULL for buy/sell rows). For converts these
  // capture the user-facing direction; the underlying primitives still
  // write to ledger_transactions / swap_transactions as before, but the
  // activity feed renders a single "Convert FROM → TO" row from this row.
  from_token: string | null;
  to_token: string | null;
  from_amount: string | null;
  to_amount: string | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
  completed_at: string | null;
}

export interface TransakFeeInfo {
  totalFee: number;
  feePercent: number;
  netCryptoAmount: number;
  feeBreakdown: { name: string; value: number }[];
}

export interface BuyQuote {
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  fiatToTusdRate: number;
  tusdAmount: string;
  tglobalAmount: string;
  ammSpotPrice: string;
  ammEffectivePrice: string;
  priceImpactBps: number;
  feeAmount: string;
  maxSlippageBps: number;
  expiresAt: Date;
  paymentToken: string;
  userBalance: string;
  fromBalance: string;
  toCharge: string;
  transakFees: TransakFeeInfo | null;
}

export interface SellQuote {
  tglobalAmount: string;
  tusdAmount: string;
  payoutCurrency: FiatCurrency;
  payoutToken: string;
  payoutAmount: string;
  tusdToPayoutRate: number;
  ammSpotPrice: string;
  ammEffectivePrice: string;
  priceImpactBps: number;
  feeAmount: string;
  maxSlippageBps: number;
  expiresAt: Date;
}

export interface ProcessResult {
  success: boolean;
  orderId: string;
  status: OrderStatus;
  txHash?: string;
  tglobalAmount?: string;
  tusdAmount?: string;
  payoutCurrency?: FiatCurrency;
  payoutToken?: string;
  payoutAmount?: string;
  error?: string;
}

const FIAT_TO_TOKEN: Record<FiatCurrency, string> = {
  USD: "USDX",
  GBP: "GBPX",
  EUR: "EURX",
  BRL: "BRLX",
};

function generateOrderId(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ============================================================================
// FIAT → USDX CONVERSION
// ============================================================================

/**
 * Convert a fiat amount to its USDX equivalent using oracle rates.
 * USD is 1:1 with USDX. Other currencies use Chainlink/Pyth rates.
 */
export async function fiatToTusd(
  fiatAmount: number,
  fiatCurrency: FiatCurrency
): Promise<{ tusdAmount: number; rate: number }> {
  if (fiatCurrency === "USD") {
    return { tusdAmount: fiatAmount, rate: 1 };
  }

  const tokenMap: Record<string, string> = {
    GBP: "GBPX",
    EUR: "EURX",
    BRL: "BRLX",
  };
  const tokenSymbol = tokenMap[fiatCurrency];
  if (!tokenSymbol) throw new Error(`Unsupported fiat currency: ${fiatCurrency}`);

  const { rate } = await getTokenUSDRate(tokenSymbol);
  // rate = how many USD per 1 unit of fiat (e.g. GBP/USD = 1.27)
  const tusdAmount = fiatAmount * rate;
  return { tusdAmount, rate };
}

/**
 * Convert USDX amount to fiat equivalent.
 */
export async function tusdToFiat(
  tusdAmount: number,
  fiatCurrency: FiatCurrency
): Promise<{ fiatAmount: number; rate: number }> {
  if (fiatCurrency === "USD") {
    return { fiatAmount: tusdAmount, rate: 1 };
  }

  const tokenMap: Record<string, string> = {
    GBP: "GBPX",
    EUR: "EURX",
    BRL: "BRLX",
  };
  const tokenSymbol = tokenMap[fiatCurrency];
  if (!tokenSymbol) throw new Error(`Unsupported fiat currency: ${fiatCurrency}`);

  const { rate } = await getTokenUSDRate(tokenSymbol);
  // rate = USD per 1 fiat unit; to get fiat from USDX: tusd / rate
  const fiatAmount = tusdAmount / rate;
  return { fiatAmount, rate };
}

// ============================================================================
// QUOTES
// ============================================================================

export async function getBuyQuote(
  fiatCurrency: FiatCurrency,
  fiatAmount: string,
  userId?: string,
  options?: { skipBalance?: boolean }
): Promise<BuyQuote> {
  const amount = parseFloat(fiatAmount);
  if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

  const paymentToken = FIAT_TO_TOKEN[fiatCurrency];

  let userBalance = "0";
  if (userId && !options?.skipBalance) {
    userBalance = await getUserBalance(userId, paymentToken);
  }
  const balanceNum = parseFloat(userBalance);
  // When `skipBalance` is set, the caller wants the FULL amount charged
  // to Transak — useful for the new Exchange "Buy with card" UX where
  // existing stablecoin balances should not subsidize the purchase.
  const fromBalance = options?.skipBalance ? 0 : Math.min(balanceNum, amount);
  const toCharge = Math.max(0, amount - fromBalance);

  // Fetch Transak fee estimate when a payment is needed
  let transakFees: TransakFeeInfo | null = null;
  let netTransakTusd = 0;

  if (toCharge > 0) {
    try {
      const tq = await getTransakPriceQuote(fiatCurrency, toCharge);
      // cryptoAmount is always in USDC (= USDX), regardless of fiat currency
      netTransakTusd = tq.cryptoAmount;
      transakFees = {
        totalFee: tq.totalFee,
        feePercent: tq.feeDecimal * 100,
        netCryptoAmount: tq.cryptoAmount,
        feeBreakdown: tq.feeBreakdown.map((f) => ({ name: f.name, value: f.value })),
      };
    } catch (err) {
      console.warn("[getBuyQuote] Transak fee estimate unavailable, using fallback schedule:", err);
      const fallback = estimateOnRampFee(toCharge, fiatCurrency);
      const netFiat = toCharge - fallback.totalFee;
      const { tusdAmount: netTusd } = await fiatToTusd(Math.max(0, netFiat), fiatCurrency);
      netTransakTusd = netTusd;
      transakFees = {
        totalFee: fallback.totalFee,
        feePercent: fallback.feePct,
        netCryptoAmount: netTusd,
        feeBreakdown: [{ name: "Transak fee (estimated)", value: fallback.totalFee }],
      };
    }
  }

  // Balance portion converted to USDX
  const { tusdAmount: balanceTusd } = await fiatToTusd(fromBalance, fiatCurrency);
  const { rate: fiatToTusdRate } = await fiatToTusd(amount, fiatCurrency);

  // Total USDX entering the AMM = balance portion + net Transak portion
  const effectiveTusd = balanceTusd + netTransakTusd;

  const tusdInWei = parseUnits(effectiveTusd.toFixed(18), 18);
  const ammQuote = await quoteSwap(false, tusdInWei);

  return {
    fiatCurrency,
    fiatAmount,
    fiatToTusdRate,
    tusdAmount: effectiveTusd.toFixed(6),
    tglobalAmount: ammQuote.amountOut,
    ammSpotPrice: ammQuote.spotPrice,
    ammEffectivePrice: ammQuote.effectivePrice,
    priceImpactBps: ammQuote.priceImpactBps,
    feeAmount: ammQuote.feeAmount,
    maxSlippageBps: getMaxSlippageBps(),
    expiresAt: new Date(Date.now() + 30000),
    paymentToken,
    userBalance,
    fromBalance: fromBalance.toFixed(6),
    toCharge: toCharge.toFixed(2),
    transakFees,
  };
}

export async function getSellQuote(
  tglobalAmount: string,
  payoutCurrency: FiatCurrency = "USD"
): Promise<SellQuote> {
  const amount = parseFloat(tglobalAmount);
  if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

  const tglobalInWei = parseUnits(amount.toFixed(18), 18);
  const ammQuote = await quoteSwap(true, tglobalInWei);

  const tusdAmountNum = parseFloat(ammQuote.amountOut);

  // If the user wants something other than USDX, the operator will convert
  // the USDX into the chosen fiat using the internal ledger swap (oracle
  // rates, processing fee bypassed). Reflect that here so the quote shows
  // the actual amount the user will receive.
  let payoutAmount: number;
  let tusdToPayoutRate: number;
  if (payoutCurrency === "USD") {
    payoutAmount = tusdAmountNum;
    tusdToPayoutRate = 1;
  } else {
    const { fiatAmount, rate } = await tusdToFiat(tusdAmountNum, payoutCurrency);
    payoutAmount = fiatAmount;
    // tusdToFiat returns USD-per-fiat-unit; invert so the number means
    // "fiat units per 1 USDX" which is what the UI wants to display.
    tusdToPayoutRate = rate > 0 ? 1 / rate : 0;
  }

  return {
    tglobalAmount,
    tusdAmount: ammQuote.amountOut,
    payoutCurrency,
    payoutToken: FIAT_TO_TOKEN[payoutCurrency],
    payoutAmount: payoutAmount.toFixed(18),
    tusdToPayoutRate,
    ammSpotPrice: ammQuote.spotPrice,
    ammEffectivePrice: ammQuote.effectivePrice,
    priceImpactBps: ammQuote.priceImpactBps,
    feeAmount: ammQuote.feeAmount,
    maxSlippageBps: getMaxSlippageBps(),
    expiresAt: new Date(Date.now() + 30000),
  };
}

// ============================================================================
// ORDER CREATION
// ============================================================================

export async function createBuyOrder(
  userId: string,
  fiatCurrency: FiatCurrency,
  fiatAmount: string,
  options?: {
    ipAddress?: string;
    userAgent?: string;
    idempotencyKey?: string;
    /**
     * When true, ignore the user's internal stablecoin balance and route
     * the FULL fiat amount through Transak. The new Exchange "Buy with
     * card" flow always sets this — users expect a card purchase to be
     * a fresh top-up, not partly drawn from an existing balance.
     */
    skipBalance?: boolean;
  }
): Promise<TradeOrder> {
  const amount = parseFloat(fiatAmount);
  if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

  // Client-supplied idempotency: if a key is supplied, short-circuit and
  // return the existing order. This protects against UI double-submits and
  // retries that happen while MySQL is flaky (the user clicks "Buy" twice,
  // or the server action retries a transient failure, etc.).
  const idempotencyKey = options?.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const [existing] = await db.execute<(RowDataPacket & TradeOrder)[]>(
      "SELECT * FROM trade_orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
      [userId, idempotencyKey]
    );
    if (existing.length > 0) {
      return existing[0];
    }
  }

  const paymentToken = FIAT_TO_TOKEN[fiatCurrency];

  // Check user's internal balance of the corresponding platform-token, unless
  // the caller asked us to skip it. `skipBalance` forces the full amount
  // through Transak (the new Exchange UI sets this).
  const userBalance = options?.skipBalance
    ? "0"
    : await getUserBalance(userId, paymentToken);
  const balanceNum = parseFloat(userBalance);
  const fromBalance = options?.skipBalance ? 0 : Math.min(balanceNum, amount);
  const toCharge = Math.max(0, amount - fromBalance);

  const { rate: fiatToTusdRate } = await fiatToTusd(amount, fiatCurrency);

  // Transak Lite-KYC (Level 1) widget floors are hard rejections — no
  // KYC upgrade can lower them, so we gate here. The Lite-KYC MAX is
  // intentionally NOT gated server-side: the widget prompts the user
  // to upgrade to Standard KYC for higher amounts, so blocking here
  // would prevent valid flows. Shared with the client chip via
  // `app/lib/transak-limits.ts`.
  if (toCharge > 0) {
    const minForCurrency = TRANSAK_MIN_PER_CURRENCY[fiatCurrency];
    if (toCharge < minForCurrency) {
      throw new Error(
        `TransakMinLimit: Minimum payment via Transak is ${minForCurrency} ${fiatCurrency}. Add to your balance to cover the remaining amount.`
      );
    }
  }

  const needsTransak = toCharge > 0;

  // When Transak is involved, fetch the real net crypto amount after fees.
  // This prevents creating an order for $20 USDX when only ~$18.2 will arrive.
  let netTransakTusd = 0;
  if (needsTransak) {
    try {
      const tq = await getTransakPriceQuote(fiatCurrency, toCharge);
      netTransakTusd = tq.cryptoAmount;
    } catch {
      const { tusdAmount: grossTusd } = await fiatToTusd(toCharge, fiatCurrency);
      netTransakTusd = grossTusd;
    }
  }

  // Balance portion → USDX
  const { tusdAmount: balanceTusdPortion } = await fiatToTusd(fromBalance, fiatCurrency);

  // Total USDX that will actually enter the AMM
  const effectiveTusd = needsTransak
    ? balanceTusdPortion + netTransakTusd
    : (await fiatToTusd(amount, fiatCurrency)).tusdAmount;

  const tusdInWei = parseUnits(effectiveTusd.toFixed(18), 18);
  const ammQuote = await quoteSwap(false, tusdInWei);

  const orderId = generateOrderId();
  const maxSlippage = getMaxSlippageBps();

  let balanceDebitTxId: string | null = null;
  let balanceSwapTxId: string | null = null;
  let balanceTusdEquivalent = 0;

  if (fromBalance > 0 && !needsTransak) {
    if (paymentToken === "USDX") {
      const debitResult = await debitBalance(userId, "USDX", fromBalance.toFixed(18), {
        notes: `Buy order ${orderId} - balance debit`,
      });
      balanceDebitTxId = debitResult.transactionId;
      balanceTusdEquivalent = fromBalance;
    } else {
      const swapResult = await executeSwap(userId, paymentToken, "USDX", fromBalance.toFixed(18), {
        notes: `Buy order ${orderId} - auto-convert ${paymentToken} to USDX`,
      });
      balanceSwapTxId = swapResult.transactionId;
      balanceTusdEquivalent = parseFloat(swapResult.toAmount);

      const debitResult = await debitBalance(userId, "USDX", swapResult.toAmount, {
        notes: `Buy order ${orderId} - USDX debit after ${paymentToken} conversion`,
      });
      balanceDebitTxId = debitResult.transactionId;
    }
  } else if (fromBalance > 0 && needsTransak) {
    balanceTusdEquivalent = balanceTusdPortion;
  }

  const initialStatus = needsTransak ? "pending_payment" : "payment_received";
  const paymentProvider = needsTransak ? "transak" : "balance";

  try {
    await db.execute<ResultSetHeader>(
      `INSERT INTO trade_orders (
        order_id, user_id, order_type, status,
        fiat_currency, fiat_amount, fiat_to_tusd_rate,
        tusd_amount, tglobal_amount,
        amm_quote_price, max_slippage_bps,
        payment_provider,
        balance_token, balance_amount, balance_tusd_equivalent,
        charged_fiat_amount, balance_debit_tx_id, balance_swap_tx_id,
        ip_address, user_agent, idempotency_key
      ) VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        userId,
        initialStatus,
        fiatCurrency,
        amount.toFixed(2),
        fiatToTusdRate.toFixed(18),
        effectiveTusd.toFixed(18),
        ammQuote.amountOut,
        ammQuote.effectivePrice,
        maxSlippage,
        paymentProvider,
        fromBalance > 0 ? paymentToken : null,
        fromBalance.toFixed(18),
        balanceTusdEquivalent.toFixed(18),
        toCharge.toFixed(2),
        balanceDebitTxId,
        balanceSwapTxId,
        options?.ipAddress ?? null,
        options?.userAgent ?? null,
        idempotencyKey,
      ]
    );
  } catch (err) {
    // Race: a concurrent request with the same idempotency key just inserted.
    // Return the committed row rather than re-running the (already partially
    // applied) balance debit / swap. The debit/swap above were tied to
    // THIS invocation — if another request reached INSERT first we must
    // accept that, but note the side-effect: the earlier debit is real.
    // For safety we let the error propagate if there was no key supplied
    // (should never dup-key without one) or if it's not a dup-key error.
    if (
      idempotencyKey &&
      err &&
      typeof err === "object" &&
      ((err as { code?: string }).code === "ER_DUP_ENTRY" ||
        (err as { errno?: number }).errno === 1062)
    ) {
      const [existing] = await db.execute<(RowDataPacket & TradeOrder)[]>(
        "SELECT * FROM trade_orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
        [userId, idempotencyKey]
      );
      if (existing.length > 0) return existing[0];
    }
    throw err;
  }

  return getOrderByOrderId(orderId);
}

export async function createSellOrder(
  userId: string,
  tglobalAmount: string,
  payoutCurrency: FiatCurrency = "USD",
  options?: { ipAddress?: string; userAgent?: string }
): Promise<TradeOrder> {
  const amount = parseFloat(tglobalAmount);
  if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

  const tglobalInWei = parseUnits(amount.toFixed(18), 18);
  const ammQuote = await quoteSwap(true, tglobalInWei);

  const orderId = generateOrderId();
  const maxSlippage = getMaxSlippageBps();

  // Debit PLAT from user's internal ledger
  const debitResult = await debitBalance(userId, "PLAT", amount.toFixed(18), {
    notes: `Sell order ${orderId}`,
  });

  // Create the trade order (sell side: AMM swap then optional USDX->fiat
  // conversion. payout_currency captures what the user wants to receive;
  // payout_amount is finalized after processing.
  //
  // Downstream mirroring is handled by the CDC scanner (sync-cdc-service),
  // which watermarks trade_orders.updated_at and enqueues every insert/change
  // — so no inline enqueue is needed here.
  await db.execute<ResultSetHeader>(
    `INSERT INTO trade_orders (
      order_id, user_id, order_type, status,
      fiat_currency, payout_currency, fiat_amount, fiat_to_tusd_rate,
      tusd_amount, tglobal_amount,
      amm_quote_price, max_slippage_bps,
      debit_transaction_id,
      payment_provider, ip_address, user_agent
    ) VALUES (?, ?, 'sell', 'executing', 'USD', ?, 0, 1, ?, ?, ?, ?, ?, 'internal', ?, ?)`,
    [
      orderId,
      userId,
      payoutCurrency,
      ammQuote.amountOut,
      amount.toFixed(18),
      ammQuote.effectivePrice,
      maxSlippage,
      debitResult.transactionId,
      options?.ipAddress ?? null,
      options?.userAgent ?? null,
    ]
  );

  // Process the sell order synchronously (operator AMM swap is fast)
  try {
    await processOrder(orderId);
  } catch (err) {
    console.error(`Failed to process sell order ${orderId}:`, err);
  }

  return getOrderByOrderId(orderId);
}

// ============================================================================
// ORDER PROCESSING
// ============================================================================

export async function processOrder(orderId: string): Promise<ProcessResult> {
  const order = await getOrderByOrderId(orderId);

  if (order.order_type === "buy") {
    return processBuyOrder(order);
  } else {
    return processSellOrder(order);
  }
}

async function processBuyOrder(order: TradeOrder): Promise<ProcessResult> {
  // Atomic claim: only one caller can transition payment_received → executing.
  // If we don't get the claim, another worker (duplicate webhook, reconciler,
  // operator retry) is already processing this order.
  const claimed = await claimOrderStatus(
    order.order_id,
    "payment_received",
    "executing"
  );

  if (!claimed) {
    const current = await getOrderByOrderId(order.order_id);
    // Recoverable case: still in `executing` — another worker owns it; return
    // current snapshot so the caller can poll for completion.
    if (current.status === "executing") {
      return {
        success: false,
        orderId: order.order_id,
        status: current.status,
        error: "Order is already being processed. Please wait.",
      };
    }
    // Terminal cases (completed / failed / slippage_fallback / price_changed):
    // return the existing result; DO NOT re-execute on-chain.
    return {
      success: current.status === "completed",
      orderId: order.order_id,
      status: current.status,
      txHash: current.operator_tx_hash ?? undefined,
      tglobalAmount: current.tglobal_amount,
      error: current.failure_reason ?? undefined,
    };
  }

  try {
    const tusdAmount = parseFloat(order.tusd_amount);

    const tusdInWei = parseUnits(tusdAmount.toFixed(18), 18);
    const ammQuote = await quoteSwap(false, tusdInWei);

    const opBalances = await getOperatorBalances();
    if (parseFloat(opBalances.tusd) < tusdAmount) {
      throw new Error(
        `Operator insufficient USDX. Need: ${tusdAmount}, Have: ${opBalances.tusd}`
      );
    }

    const amountOut = parseFloat(ammQuote.amountOut);
    const slippageFactor = 1 - order.max_slippage_bps / 10000;
    const minOut = (amountOut * slippageFactor).toFixed(18);

    const [operatorAddress, userSmartAccount] = await Promise.all([
      getOperatorSmartAccountAddress(),
      getSmartAccountAddressForUser(order.user_id),
    ]);
    const userAddress = userSmartAccount || operatorAddress;

    const swapResult = await executeOperatorBuy(
      tusdAmount.toFixed(18),
      minOut,
      userAddress
    );

    // Persist tx_hash + quoted amounts immediately so a reconciler can finish
    // the credit if this request dies (DB blip, process kill) before the
    // credit/UPDATE below lands. Funds on-chain always go to the OPERATOR
    // wallet — the user's view of their position lives entirely in the
    // ledger, so we need everything required to credit them later.
    await db.execute(
      `UPDATE trade_orders SET
        operator_tx_hash = ?,
        operator_smart_account = ?,
        tglobal_amount = ?,
        executed_price = ?,
        slippage_bps = ?,
        executed_at = NOW()
      WHERE order_id = ?`,
      [
        swapResult.txHash,
        operatorAddress,
        ammQuote.amountOut,
        ammQuote.effectivePrice,
        ammQuote.priceImpactBps,
        order.order_id,
      ]
    );

    // Idempotent credit: guarded by idempotency_key on `ledger_transactions`.
    // If the process crashes after credit but before the final status UPDATE,
    // a retry re-uses the existing transaction id rather than double-crediting.
    const creditResult = await creditBalance(order.user_id, "PLAT", ammQuote.amountOut, {
      txHash: swapResult.txHash,
      notes: `Buy order ${order.order_id}`,
      createdBy: "operator",
      idempotencyKey: `trade:${order.order_id}:credit`,
    });

    await db.execute(
      `UPDATE trade_orders SET
        status = 'completed',
        tglobal_amount = ?,
        executed_price = ?,
        slippage_bps = ?,
        operator_tx_hash = ?,
        operator_smart_account = ?,
        credit_transaction_id = ?,
        executed_at = COALESCE(executed_at, NOW()),
        completed_at = NOW()
      WHERE order_id = ?`,
      [
        ammQuote.amountOut,
        ammQuote.effectivePrice,
        ammQuote.priceImpactBps,
        swapResult.txHash,
        operatorAddress,
        creditResult.transactionId,
        order.order_id,
      ]
    );

    return {
      success: true,
      orderId: order.order_id,
      status: "completed",
      txHash: swapResult.txHash,
      tglobalAmount: ammQuote.amountOut,
    };
  } catch (error) {
    const msg = formatTradeExecutionError(error);

    const isSlippageError =
      msg.includes("InsufficientOutput") ||
      msg.includes("SlippageExceeded");

    if (isSlippageError) {
      try {
        const tusdAmount = parseFloat(order.tusd_amount);
        const creditResult = await creditBalance(order.user_id, "USDX", tusdAmount.toFixed(18), {
          notes: `Price-change refund for buy order ${order.order_id}`,
          createdBy: "operator",
          idempotencyKey: `trade:${order.order_id}:slippage-refund`,
        });

        const isTransakFunded = order.payment_provider === "transak";
        const fallbackStatus: OrderStatus = isTransakFunded
          ? "price_changed"
          : "slippage_fallback";

        await db.execute(
          `UPDATE trade_orders SET
            status = ?,
            credit_transaction_id = ?,
            failure_reason = ?,
            completed_at = NOW()
          WHERE order_id = ?`,
          [fallbackStatus, creditResult.transactionId, redactPrivateKey(msg), order.order_id]
        );

        const userMsg = isTransakFunded
          ? "Price moved while your payment was processing. Your USDX has been returned to your balance — you can retry at the current price."
          : "Price moved too much. Your USDX equivalent has been credited to your balance instead.";

        return {
          success: false,
          orderId: order.order_id,
          status: fallbackStatus,
          tusdAmount: tusdAmount.toFixed(18),
          error: userMsg,
        };
      } catch (fallbackError) {
        console.error("Slippage fallback failed:", fallbackError);
      }
    }

    try {
      const tusdAmount = parseFloat(order.tusd_amount);
      if (tusdAmount > 0) {
        await creditBalance(order.user_id, "USDX", tusdAmount.toFixed(18), {
          notes: `Execution failure refund for buy order ${order.order_id}`,
          createdBy: "operator",
          idempotencyKey: `trade:${order.order_id}:failure-refund`,
        });
      }
    } catch (refundError) {
      console.error("USDX refund on failure failed:", refundError);
    }

    await updateOrderStatus(order.order_id, "failed", msg);

    return {
      success: false,
      orderId: order.order_id,
      status: "failed",
      error: msg,
    };
  }
}

async function processSellOrder(order: TradeOrder): Promise<ProcessResult> {
  // Sell orders enter as `executing` (see createSellOrder). If another worker
  // already advanced the state past executing, bail out.
  const fresh = await getOrderByOrderId(order.order_id);
  if (fresh.status !== "executing") {
    return {
      success: fresh.status === "completed",
      orderId: order.order_id,
      status: fresh.status,
      txHash: fresh.operator_tx_hash ?? undefined,
      tusdAmount: fresh.tusd_amount,
      error: fresh.failure_reason ?? undefined,
    };
  }

  try {
    const tglobalAmount = parseFloat(order.tglobal_amount);
    const tglobalInWei = parseUnits(tglobalAmount.toFixed(18), 18);
    const ammQuote = await quoteSwap(true, tglobalInWei);

    const opBalances = await getOperatorBalances();
    if (parseFloat(opBalances.tglobal) < tglobalAmount) {
      throw new Error(
        `Operator insufficient PLAT. Need: ${tglobalAmount}, Have: ${opBalances.tglobal}`
      );
    }

    const amountOut = parseFloat(ammQuote.amountOut);
    const slippageFactor = 1 - order.max_slippage_bps / 10000;
    const minOut = (amountOut * slippageFactor).toFixed(18);

    const [operatorAddress, userSmartAccount] = await Promise.all([
      getOperatorSmartAccountAddress(),
      getSmartAccountAddressForUser(order.user_id),
    ]);
    const userAddress = userSmartAccount || operatorAddress;

    const swapResult = await executeOperatorSell(
      tglobalAmount.toFixed(18),
      minOut,
      userAddress
    );

    const tusdOut = ammQuote.amountOut;

    // Persist tx_hash + quoted amounts immediately so a reconciler can finish
    // the credit if this request dies before the credit/UPDATE below lands.
    await db.execute(
      `UPDATE trade_orders SET
        operator_tx_hash = ?,
        operator_smart_account = ?,
        tusd_amount = ?,
        executed_price = ?,
        slippage_bps = ?,
        executed_at = NOW()
      WHERE order_id = ?`,
      [
        swapResult.txHash,
        operatorAddress,
        tusdOut,
        ammQuote.effectivePrice,
        ammQuote.priceImpactBps,
        order.order_id,
      ]
    );

    const creditResult = await creditBalance(order.user_id, "USDX", tusdOut, {
      txHash: swapResult.txHash,
      notes: `Sell order ${order.order_id}`,
      createdBy: "operator",
      idempotencyKey: `trade:${order.order_id}:credit`,
    });

    // ── Optional second leg: convert USDX → user's chosen fiat ──────────
    // The user may have requested a non-USD payout. The internal ledger swap
    // is an atomic balance move (no on-chain action), so we run it here with
    // the processing fee disabled — the trade flow already charged its AMM
    // fee, and we treat both legs as one combined trade.
    const payoutCurrency = (order.payout_currency || "USD") as FiatCurrency;
    const payoutToken = FIAT_TO_TOKEN[payoutCurrency];
    let payoutAmountStr = tusdOut;
    let payoutSwapTxId: string | null = null;
    let payoutFailureNote: string | null = null;

    if (payoutCurrency !== "USD") {
      try {
        const conversion = await executeSwap(
          order.user_id,
          "USDX",
          payoutToken,
          tusdOut,
          {
            notes: `Sell order ${order.order_id} payout conversion to ${payoutToken}`,
            skipProcessingFee: true,
          }
        );
        payoutAmountStr = conversion.toAmount;
        payoutSwapTxId = conversion.transactionId;
      } catch (conversionError) {
        // Per spec: if the auto-conversion fails (rare — e.g. oracle outage),
        // leave the USDX credited and complete the order. Surface a
        // failure_reason so the user knows to manually swap from the regular
        // Swap page when oracles recover.
        const convMsg =
          conversionError instanceof Error
            ? conversionError.message
            : String(conversionError);
        console.error(
          `[processSellOrder] USDX->${payoutToken} conversion failed for order ${order.order_id}:`,
          conversionError
        );
        payoutFailureNote =
          `Auto-conversion to ${payoutToken} failed (${convMsg}). ` +
          `Your USDX has been credited — you can convert it manually from the Swap page.`;
      }
    }

    await db.execute(
      `UPDATE trade_orders SET
        status = 'completed',
        tusd_amount = ?,
        payout_amount = ?,
        executed_price = ?,
        slippage_bps = ?,
        operator_tx_hash = ?,
        operator_smart_account = ?,
        credit_transaction_id = ?,
        payout_swap_transaction_id = ?,
        failure_reason = ?,
        executed_at = COALESCE(executed_at, NOW()),
        completed_at = NOW()
      WHERE order_id = ?`,
      [
        tusdOut,
        payoutAmountStr,
        ammQuote.effectivePrice,
        ammQuote.priceImpactBps,
        swapResult.txHash,
        operatorAddress,
        creditResult.transactionId,
        payoutSwapTxId,
        payoutFailureNote,
        order.order_id,
      ]
    );

    return {
      success: true,
      orderId: order.order_id,
      status: "completed",
      txHash: swapResult.txHash,
      tusdAmount: tusdOut,
      payoutCurrency,
      payoutToken,
      payoutAmount: payoutAmountStr,
      error: payoutFailureNote ?? undefined,
    };
  } catch (error) {
    const msg = formatTradeExecutionError(error);

    try {
      const tglobalAmount = parseFloat(order.tglobal_amount);
      await creditBalance(order.user_id, "PLAT", tglobalAmount.toFixed(18), {
        notes: `Sell order ${order.order_id} failed, refunding PLAT`,
        createdBy: "operator",
        idempotencyKey: `trade:${order.order_id}:failure-refund`,
      });
    } catch (refundError) {
      console.error("PLAT refund failed:", refundError);
    }

    await updateOrderStatus(order.order_id, "failed", msg);

    return {
      success: false,
      orderId: order.order_id,
      status: "failed",
      error: msg,
    };
  }
}

// ============================================================================
// ORDER QUERIES
// ============================================================================

export async function getOrderByOrderId(orderId: string): Promise<TradeOrder> {
  const [rows] = await db.execute<(RowDataPacket & TradeOrder)[]>(
    "SELECT * FROM trade_orders WHERE order_id = ?",
    [orderId]
  );
  if (rows.length === 0) throw new Error(`Order not found: ${orderId}`);
  return rows[0];
}

export async function getOrderById(id: number): Promise<TradeOrder> {
  const [rows] = await db.execute<(RowDataPacket & TradeOrder)[]>(
    "SELECT * FROM trade_orders WHERE id = ?",
    [id]
  );
  if (rows.length === 0) throw new Error(`Order not found: ${id}`);
  return rows[0];
}

export async function getOrderHistory(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<TradeOrder[]> {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const [rows] = await db.query<(RowDataPacket & TradeOrder)[]>(
    `SELECT * FROM trade_orders
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );

  return rows;
}

/** Admin list: filters and sort use bound params; identifiers are whitelisted only. */
export interface AdminTradeOrderListParams {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** Inclusive, `YYYY-MM-DD` (calendar day start UTC) */
  dateFrom?: string;
  /** Inclusive, `YYYY-MM-DD` (calendar day end UTC) */
  dateTo?: string;
  status?: OrderStatus | "";
  orderType?: OrderType | "";
  /** Substring match on user_id */
  userIdContains?: string;
}

const ADMIN_ORDER_SORT_SQL: Record<string, string> = {
  created_at: "created_at",
  updated_at: "updated_at",
  completed_at: "completed_at",
  status: "status",
  order_type: "order_type",
  fiat_amount: "CAST(fiat_amount AS DECIMAL(36,18))",
  tusd_amount: "CAST(tusd_amount AS DECIMAL(36,18))",
};

const ORDER_STATUSES: OrderStatus[] = [
  "pending_payment",
  "payment_received",
  "executing",
  "completed",
  "slippage_fallback",
  "price_changed",
  "insufficient_balance",
  "failed",
  "cancelled",
];

export async function listTradeOrdersForAdmin(
  params: AdminTradeOrderListParams = {}
): Promise<{ orders: TradeOrder[]; total: number }> {
  const safeLimit = Math.max(1, Math.min(100, Number(params.limit) || 50));
  const safeOffset = Math.max(0, Number(params.offset) || 0);

  const sortKey = params.sortBy && ADMIN_ORDER_SORT_SQL[params.sortBy] ? params.sortBy : "created_at";
  const orderSql = ADMIN_ORDER_SORT_SQL[sortKey];
  const dir = params.sortDir === "asc" ? "ASC" : "DESC";

  const where: string[] = [];
  const values: unknown[] = [];

  if (params.dateFrom?.trim()) {
    where.push("created_at >= ?");
    values.push(`${params.dateFrom.trim()} 00:00:00`);
  }
  if (params.dateTo?.trim()) {
    where.push("created_at <= ?");
    values.push(`${params.dateTo.trim()} 23:59:59`);
  }
  if (params.status && ORDER_STATUSES.includes(params.status as OrderStatus)) {
    where.push("status = ?");
    values.push(params.status);
  }
  if (params.orderType === "buy" || params.orderType === "sell") {
    where.push("order_type = ?");
    values.push(params.orderType);
  }
  const uid = params.userIdContains?.trim();
  if (uid) {
    where.push("INSTR(user_id, ?) > 0");
    values.push(uid);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const [countRows] = await adminDb.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM trade_orders ${whereClause}`,
    values
  );
  const total = Number(countRows[0]?.cnt) || 0;

  const [rows] = await adminDb.query<(RowDataPacket & TradeOrder)[]>(
    `SELECT * FROM trade_orders ${whereClause}
     ORDER BY ${orderSql} ${dir}
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    values
  );

  return { orders: rows, total };
}

export async function getAllOrders(
  limit: number = 50,
  offset: number = 0
): Promise<TradeOrder[]> {
  const { orders } = await listTradeOrdersForAdmin({ limit, offset });
  return orders;
}

// ============================================================================
// ONRAMP LINKING & STATUS POLLING
// ============================================================================

/**
 * Link a trade order to an onramp order (for Transak payment flow).
 */
export async function linkOnRampToTradeOrder(
  tradeOrderId: string,
  onrampOrderId: string
): Promise<void> {
  await db.execute(
    "UPDATE trade_orders SET onramp_order_id = ? WHERE order_id = ?",
    [onrampOrderId, tradeOrderId]
  );
}

/**
 * Get order status for polling from the client.
 * Returns a lightweight status object without sensitive fields.
 */
export async function getOrderStatus(
  orderId: string,
  userId: string
): Promise<{
  status: OrderStatus;
  tglobalAmount: string;
  tusdAmount: string;
  txHash: string | null;
  failureReason: string | null;
  ammQuotePrice: string | null;
} | null> {
  const [rows] = await db.execute<(RowDataPacket & TradeOrder)[]>(
    "SELECT * FROM trade_orders WHERE order_id = ? AND user_id = ?",
    [orderId, userId]
  );
  if (rows.length === 0) return null;
  const order = rows[0];
  return {
    status: order.status,
    tglobalAmount: order.tglobal_amount,
    tusdAmount: order.tusd_amount,
    txHash: order.operator_tx_hash,
    failureReason: order.failure_reason,
    ammQuotePrice: order.amm_quote_price,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Atomically cancel a pending_payment order using row-level locking.
 *
 * Uses SELECT … FOR UPDATE to prevent a race with confirmPayment.
 * If a webhook-triggered confirmPayment is already in progress and holds
 * the lock, this will wait then see the updated status and refuse to cancel.
 */
export async function cancelPendingOrder(
  orderId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute<(RowDataPacket & TradeOrder)[]>(
      "SELECT * FROM trade_orders WHERE order_id = ? FOR UPDATE",
      [orderId]
    );
    const order = rows[0];
    if (!order) {
      await connection.rollback();
      return { success: false, error: "Order not found" };
    }
    if (String(order.user_id) !== String(userId)) {
      await connection.rollback();
      return { success: false, error: "Not authorized" };
    }
    if (order.status !== "pending_payment") {
      await connection.rollback();
      return {
        success: false,
        error: `Cannot cancel — order status is already '${order.status}'`,
      };
    }

    await connection.execute(
      "UPDATE trade_orders SET status = 'cancelled', failure_reason = 'Cancelled by user' WHERE order_id = ?",
      [orderId]
    );

    await connection.commit();
    return { success: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  failureReason?: string
): Promise<void> {
  if (failureReason) {
    await db.execute(
      "UPDATE trade_orders SET status = ?, failure_reason = ? WHERE order_id = ?",
      [status, redactPrivateKey(failureReason), orderId]
    );
  } else {
    await db.execute(
      "UPDATE trade_orders SET status = ? WHERE order_id = ?",
      [status, orderId]
    );
  }
}

/**
 * Atomically claim an order for processing by transitioning from an expected
 * status into `toStatus`. Returns `true` if this caller got the claim, `false`
 * if another worker already moved the row.
 *
 * This is the single point of contention between duplicate webhook retries,
 * polling reconcilers, and operator-triggered retries — everyone must go
 * through this before submitting an on-chain tx or touching the ledger.
 */
async function claimOrderStatus(
  orderId: string,
  fromStatus: OrderStatus,
  toStatus: OrderStatus
): Promise<boolean> {
  const [result] = await db.execute<ResultSetHeader>(
    "UPDATE trade_orders SET status = ? WHERE order_id = ? AND status = ?",
    [toStatus, orderId, fromStatus]
  );
  return result.affectedRows === 1;
}

// ============================================================================
// RECONCILIATION / RECOVERY
// ============================================================================

export type StuckTradeOrderRecovery =
  | { orderId: string; outcome: "completed"; txHash: string; creditTransactionId: string }
  | { orderId: string; outcome: "skipped"; reason: string }
  | { orderId: string; outcome: "needs_manual_review"; reason: string };

/**
 * Re-drive a trade order that got stuck in `executing`.
 *
 * Because operator-wallet swaps never send funds to the end user on-chain
 * (the operator holds the outputs; the user's position lives in the ledger),
 * the only two things that can be wrong on a stuck row are:
 *
 *   A. `operator_tx_hash IS NOT NULL` but `credit_transaction_id IS NULL`
 *      → on-chain swap succeeded, ledger credit never landed. SAFE to re-run
 *        the credit (idempotency key on ledger_transactions prevents dupes).
 *
 *   B. `operator_tx_hash IS NULL`
 *      → we don't know whether the chain tx ran. We DO NOT auto-finalise
 *        these because auto-refunding could double-refund if the chain
 *        swap actually succeeded. Flagged for operator review instead.
 *
 * Returns `outcome: "completed"` only when the ledger was credited on this
 * call OR a prior successful credit was detected via idempotency lookup.
 */
export async function recoverStuckExecutingOrder(
  orderId: string
): Promise<StuckTradeOrderRecovery> {
  const order = await getOrderByOrderId(orderId);

  if (order.status !== "executing") {
    return {
      orderId,
      outcome: "skipped",
      reason: `Order status is '${order.status}', not 'executing'.`,
    };
  }

  if (order.credit_transaction_id) {
    // Already credited — just finalise status if somehow still stuck.
    await db.execute(
      `UPDATE trade_orders SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE order_id = ? AND status = 'executing'`,
      [orderId]
    );
    return {
      orderId,
      outcome: "completed",
      txHash: order.operator_tx_hash ?? "",
      creditTransactionId: order.credit_transaction_id,
    };
  }

  if (!order.operator_tx_hash) {
    return {
      orderId,
      outcome: "needs_manual_review",
      reason:
        "No operator_tx_hash recorded. Chain state unknown — operator must verify wallet tx history before retry/refund.",
    };
  }

  const creditToken = order.order_type === "buy" ? "PLAT" : "USDX";
  const rawAmount =
    order.order_type === "buy" ? order.tglobal_amount : order.tusd_amount;
  const amount = parseFloat(rawAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      orderId,
      outcome: "needs_manual_review",
      reason: `Stored ${creditToken} amount is invalid (${rawAmount}). Cannot safely credit.`,
    };
  }

  // Idempotent: if credit already landed under this key, creditBalance
  // returns the existing transaction id without double-writing the ledger.
  const creditResult = await creditBalance(
    order.user_id,
    creditToken,
    amount.toFixed(18),
    {
      txHash: order.operator_tx_hash,
      notes: `Reconciliation: finalising stuck ${order.order_type} order ${orderId}`,
      createdBy: "reconciler",
      idempotencyKey: `trade:${orderId}:credit`,
    }
  );

  await db.execute(
    `UPDATE trade_orders SET
      status = 'completed',
      credit_transaction_id = ?,
      completed_at = COALESCE(completed_at, NOW())
    WHERE order_id = ? AND status = 'executing'`,
    [creditResult.transactionId, orderId]
  );

  return {
    orderId,
    outcome: "completed",
    txHash: order.operator_tx_hash,
    creditTransactionId: creditResult.transactionId,
  };
}

interface StuckTradeRow extends RowDataPacket {
  order_id: string;
  order_type: "buy" | "sell";
  operator_tx_hash: string | null;
  credit_transaction_id: string | null;
  updated_at: string;
}

/**
 * Return candidate `executing` orders older than `minAgeMinutes` that look
 * eligible for recovery. Used by the cron reconciler.
 */
export async function findStuckExecutingOrders(
  minAgeMinutes: number,
  limit: number
): Promise<StuckTradeRow[]> {
  // Excludes order_type='convert' — the recover function below only
  // knows how to finalise buy/sell credit semantics. Convert orders
  // have direction-specific recovery (which side gets credited depends
  // on from_token / to_token) so they're left for manual review.
  // Stuck converts are vanishingly rare because the path is synchronous
  // and atomic from createConvertOrder's perspective.
  const [rows] = await db.query<StuckTradeRow[]>(
    `SELECT order_id, order_type, operator_tx_hash, credit_transaction_id, updated_at
       FROM trade_orders
      WHERE status = 'executing'
        AND order_type IN ('buy', 'sell')
        AND updated_at < (NOW() - INTERVAL ? MINUTE)
      ORDER BY updated_at ASC
      LIMIT ?`,
    [minAgeMinutes, limit]
  );
  return rows;
}

/**
 * Mark a buy order as payment received and trigger processing.
 *
 * For Transak-funded orders the balance debit was deferred at creation time.
 * Now that the Transak USDX credit has landed in the user's ledger we:
 *   1. Convert + debit the user's balance portion (if any)
 *   2. Recalculate the actual total USDX available for the AMM swap
 *   3. Trigger order execution with the fresh numbers
 *
 * Uses an atomic SELECT … FOR UPDATE to claim the order, preventing a
 * concurrent cancelPendingOrder (or duplicate webhook) from interfering.
 */
export async function confirmPayment(
  orderId: string,
  paymentReference: string
): Promise<ProcessResult> {
  // ── Atomic status claim: pending_payment → payment_received ──
  // This short transaction holds a row lock so that cancelPendingOrder
  // (or a duplicate webhook) can't modify the order concurrently.
  const lockConn = await db.getConnection();
  let order: TradeOrder;
  try {
    await lockConn.beginTransaction();
    const [rows] = await lockConn.execute<(RowDataPacket & TradeOrder)[]>(
      "SELECT * FROM trade_orders WHERE order_id = ? FOR UPDATE",
      [orderId]
    );
    if (rows.length === 0) {
      await lockConn.rollback();
      throw new Error(`Order not found: ${orderId}`);
    }
    order = rows[0];

    if (order.status !== "pending_payment") {
      await lockConn.rollback();
      throw new Error(
        `Order ${orderId} is not awaiting payment (status: ${order.status})`
      );
    }

    // Immediately transition to a transient status so no other path can claim it.
    await lockConn.execute(
      "UPDATE trade_orders SET status = 'payment_received', payment_reference = ? WHERE order_id = ?",
      [paymentReference, orderId]
    );
    await lockConn.commit();
  } catch (error) {
    await lockConn.rollback();
    throw error;
  } finally {
    lockConn.release();
  }

  // From here on the order is 'payment_received' — safe from cancel races.

  const balanceAmount = parseFloat(order.balance_amount);
  const balanceToken = order.balance_token;
  const chargedFiat = parseFloat(order.charged_fiat_amount);

  let balanceDebitTxId: string | null = null;
  let balanceSwapTxId: string | null = null;
  let actualBalanceTusd = 0;

  // --- Deferred balance debit ---
  if (balanceAmount > 0 && balanceToken) {
    const currentBalance = await getUserBalance(order.user_id, balanceToken);
    const available = parseFloat(currentBalance);

    if (available < balanceAmount * 0.99) {
      // User no longer has enough of the original token.
      // Their Transak USDX is already in their ledger; mark order so they
      // can retry a new trade from balance.
      await db.execute(
        `UPDATE trade_orders SET
          status = 'insufficient_balance',
          failure_reason = ?
        WHERE order_id = ?`,
        [
          `Needed ${balanceAmount.toFixed(4)} ${balanceToken} but only ${available.toFixed(4)} available`,
          orderId,
        ]
      );

      return {
        success: false,
        orderId,
        status: "insufficient_balance",
        error: "Your balance changed while waiting for payment. Your deposit is in your balance — you can retry the trade.",
      };
    }

    // Perform the debit now. Idempotency keys guard against a duplicate
    // webhook retry (or reconciler replay) re-debiting the user after the
    // outer status UPDATE raced to `payment_received` again.
    if (balanceToken === "USDX") {
      const debitResult = await debitBalance(order.user_id, "USDX", balanceAmount.toFixed(18), {
        notes: `Buy order ${orderId} - deferred balance debit`,
        idempotencyKey: `trade:${orderId}:deferred-balance-debit`,
      });
      balanceDebitTxId = debitResult.transactionId;
      actualBalanceTusd = balanceAmount;
    } else {
      const swapResult = await executeSwap(
        order.user_id,
        balanceToken,
        "USDX",
        balanceAmount.toFixed(18),
        { notes: `Buy order ${orderId} - deferred auto-convert ${balanceToken} to USDX` }
      );
      balanceSwapTxId = swapResult.transactionId;
      actualBalanceTusd = parseFloat(swapResult.toAmount);

      const debitResult = await debitBalance(order.user_id, "USDX", swapResult.toAmount, {
        notes: `Buy order ${orderId} - USDX debit after ${balanceToken} conversion`,
        idempotencyKey: `trade:${orderId}:deferred-conv-debit`,
      });
      balanceDebitTxId = debitResult.transactionId;
    }
  }

  // Look up the actual USDX credited from the onramp order rather than
  // assuming fiat 1:1 — Transak takes fees, so $20 fiat → ~$18.2 USDC.
  let transakTusd = 0;
  if (chargedFiat > 0 && order.onramp_order_id) {
    const [onrampRows] = await db.execute<RowDataPacket[]>(
      "SELECT tusd_amount FROM onramp_orders WHERE order_id = ?",
      [order.onramp_order_id]
    );
    if (onrampRows.length > 0 && onrampRows[0].tusd_amount) {
      transakTusd = parseFloat(onrampRows[0].tusd_amount);
    }
  }
  if (transakTusd <= 0 && chargedFiat > 0) {
    const currentTusd = await getUserBalance(order.user_id, "USDX");
    transakTusd = Math.min(parseFloat(currentTusd), chargedFiat);
    console.warn(
      `[confirmPayment] Could not find onramp USDX for order ${orderId}, using balance fallback: ${transakTusd}`
    );
  }

  // Debit the Transak-credited USDX from the user's balance.
  // The webhook already credited this amount; now we spend it on the AMM swap.
  let transakDebitTxId: string | null = null;
  if (transakTusd > 0) {
    const debitResult = await debitBalance(order.user_id, "USDX", transakTusd.toFixed(18), {
      notes: `Buy order ${orderId} - Transak USDX debit for AMM swap`,
      idempotencyKey: `trade:${orderId}:transak-debit`,
    });
    transakDebitTxId = debitResult.transactionId;
  }

  const actualTusd = actualBalanceTusd + transakTusd;

  await db.execute(
    `UPDATE trade_orders SET
      balance_debit_tx_id = ?,
      balance_swap_tx_id = ?,
      debit_transaction_id = ?,
      balance_tusd_equivalent = ?,
      tusd_amount = ?
    WHERE order_id = ?`,
    [
      balanceDebitTxId,
      balanceSwapTxId,
      transakDebitTxId,
      actualBalanceTusd.toFixed(18),
      actualTusd.toFixed(18),
      orderId,
    ]
  );

  return processOrder(orderId);
}

// ============================================================================
// CONVERT (PLAT ↔ stablecoin, internal-only)
// ============================================================================
// User-initiated conversions involving PLAT on either side. The four
// sub-cases compose the existing primitives the Buy/Sell paths use, but
// without any Transak / fiat leg:
//
//   1. USDX          → PLAT   : 1 AMM hop (operator-mediated)
//   2. PLAT       → USDX      : 1 AMM hop (operator-mediated)
//   3. non-USD stable → PLAT   : ledger swap → USDX, then AMM hop
//   4. PLAT       → non-USD stable: AMM hop → USDX, then ledger swap
//
// Failure policy (chosen at design time):
//   • Refund atomically: if the AMM leg fails after a ledger leg succeeded
//     (case 3), reverse the ledger leg so the user gets the source token
//     back. Case 1/2 just credit the source token back. Case 4 — if the
//     ledger leg fails after the AMM leg succeeded, we cannot un-swap the
//     AMM, so we leave the user with USDX and mark the order completed
//     with a note. That's a vanishingly rare path (ledger swap is a pure
//     DB op).
//
// All conversion orders write a single `trade_orders` row with
// `order_type = 'convert'`, populating from_token/to_token/from_amount/
// to_amount. The activity feed reads this row and renders a single
// "Convert FROM → TO" entry; any swap_transactions row the ledger leg
// creates is deduped against `payout_swap_transaction_id`.

export type StableToken = "USDX" | "EURX" | "GBPX" | "BRLX";
export type ConvertToken = StableToken | "PLAT";

const STABLES: readonly StableToken[] = ["USDX", "EURX", "GBPX", "BRLX"];

export interface ConvertQuote {
  fromToken: ConvertToken;
  toToken: ConvertToken;
  fromAmount: string;
  /** Final token amount the user would receive. */
  toAmount: string;
  /** Display rate, "1 fromToken = X toToken". */
  rate: number;
  /** AMM spot price (USDX per PLAT) at quote time. */
  ammSpotPrice: string;
  /** AMM execution price for the leg involving PLAT. */
  ammEffectivePrice: string;
  /** AMM price impact in basis points (100 bps = 1%). Lets the UI show
   *  the "Impact on the PLAT price" row identically to the Buy/Sell
   *  forms. Surfaced from the underlying `quoteSwap` call. */
  priceImpactBps: number;
  /** Slippage cap that will be applied at execution time, in basis points. */
  maxSlippageBps: number;
  /** USD-equivalent of the source amount — used by the security check
   *  upstream so the daily-limit math matches the Convert tab today. */
  fromUSDValue: number;
  expiresAt: Date;
}

function isStable(tok: string): tok is StableToken {
  return (STABLES as readonly string[]).includes(tok);
}

/**
 * Quote a convert. Branches by direction. For two-leg cases, multiplies
 * the Chainlink-rate leg by the AMM leg.
 */
export async function getConvertQuote(
  fromToken: ConvertToken,
  toToken: ConvertToken,
  fromAmount: string
): Promise<ConvertQuote> {
  const amount = parseFloat(fromAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid amount");
  }
  if (fromToken === toToken) {
    throw new Error("Cannot convert same token");
  }
  if (fromToken !== "PLAT" && toToken !== "PLAT") {
    throw new Error("Use the ledger swap path for stable↔stable conversions");
  }

  const maxSlippageBps = getMaxSlippageBps();

  // `getTokenUSDRate` only knows about USDX/EURX/GBPX/BRLX — PLAT's
  // USD price isn't on Chainlink, it comes out of the AMM. We compute
  // `fromUSDValue` per-case below, deriving PLAT's USD price from the
  // pool's spot price (USDX per PLAT ≈ USD per PLAT, since USDX
  // is 1:1 with USD).
  let fromUSDValue: number;

  // Case 1: USDX → PLAT (single AMM hop)
  if (fromToken === "USDX" && toToken === "PLAT") {
    const ammQuote = await quoteSwap(false, parseUnits(amount.toFixed(18), 18));
    const toAmount = parseFloat(ammQuote.amountOut);
    fromUSDValue = amount; // USDX is 1:1 with USD
    return {
      fromToken,
      toToken,
      fromAmount,
      toAmount: toAmount.toFixed(18),
      rate: toAmount / amount,
      ammSpotPrice: ammQuote.spotPrice,
      ammEffectivePrice: ammQuote.effectivePrice,
      priceImpactBps: ammQuote.priceImpactBps,
      maxSlippageBps,
      fromUSDValue,
      expiresAt: new Date(Date.now() + 30_000),
    };
  }

  // Case 2: PLAT → USDX (single AMM hop)
  if (fromToken === "PLAT" && toToken === "USDX") {
    const ammQuote = await quoteSwap(true, parseUnits(amount.toFixed(18), 18));
    const toAmount = parseFloat(ammQuote.amountOut);
    // USD value = PLAT amount × (USDX per PLAT spot price).
    // USDX ≈ USD so the spot price doubles as PLAT's USD price.
    fromUSDValue = amount * parseFloat(ammQuote.spotPrice);
    return {
      fromToken,
      toToken,
      fromAmount,
      toAmount: toAmount.toFixed(18),
      rate: toAmount / amount,
      ammSpotPrice: ammQuote.spotPrice,
      ammEffectivePrice: ammQuote.effectivePrice,
      priceImpactBps: ammQuote.priceImpactBps,
      maxSlippageBps,
      fromUSDValue,
      expiresAt: new Date(Date.now() + 30_000),
    };
  }

  // Case 3: non-USD stable → PLAT (ledger swap to USDX, then AMM hop)
  if (isStable(fromToken) && toToken === "PLAT") {
    // Ledger leg uses Chainlink: source → USDX at the source's USD rate.
    // No processing fee (mirrors the on-ramp post-credit chain).
    const fromUSDRate = (await getTokenUSDRate(fromToken)).rate;
    const usdxAmount = amount * fromUSDRate;
    fromUSDValue = usdxAmount; // already in USD terms (= USDX intermediate)
    const ammQuote = await quoteSwap(
      false,
      parseUnits(usdxAmount.toFixed(18), 18)
    );
    const toAmount = parseFloat(ammQuote.amountOut);
    return {
      fromToken,
      toToken,
      fromAmount,
      toAmount: toAmount.toFixed(18),
      rate: toAmount / amount,
      ammSpotPrice: ammQuote.spotPrice,
      ammEffectivePrice: ammQuote.effectivePrice,
      priceImpactBps: ammQuote.priceImpactBps,
      maxSlippageBps,
      fromUSDValue,
      expiresAt: new Date(Date.now() + 30_000),
    };
  }

  // Case 4: PLAT → non-USD stable (AMM hop, then ledger swap)
  if (fromToken === "PLAT" && isStable(toToken) && toToken !== "USDX") {
    const ammQuote = await quoteSwap(true, parseUnits(amount.toFixed(18), 18));
    const usdxOut = parseFloat(ammQuote.amountOut);
    const toUSDRate = (await getTokenUSDRate(toToken)).rate;
    // usdxOut USDX ÷ (toUSDRate USD per 1 toToken) = toToken amount
    const toAmount = usdxOut / toUSDRate;
    // USD value of PLAT input comes from the AMM spot price.
    fromUSDValue = amount * parseFloat(ammQuote.spotPrice);
    return {
      fromToken,
      toToken,
      fromAmount,
      toAmount: toAmount.toFixed(18),
      rate: toAmount / amount,
      ammSpotPrice: ammQuote.spotPrice,
      ammEffectivePrice: ammQuote.effectivePrice,
      priceImpactBps: ammQuote.priceImpactBps,
      maxSlippageBps,
      fromUSDValue,
      expiresAt: new Date(Date.now() + 30_000),
    };
  }

  throw new Error(`Unsupported convert direction: ${fromToken} → ${toToken}`);
}

/**
 * Insert a fresh trade_orders row for a Convert. Centralised so the four
 * direction-specific processors below all persist consistently.
 */
async function insertConvertOrderRow(params: {
  userId: string;
  fromToken: ConvertToken;
  toToken: ConvertToken;
  fromAmount: number;
  maxSlippageBps: number;
  idempotencyKey: string | null;
  ipAddress?: string;
  userAgent?: string;
}): Promise<string> {
  const orderId = generateOrderId();
  // trade_orders.fiat_currency is NOT NULL with a 4-value enum, so we
  // pick a dummy compatible value per direction even when the convert
  // isn't really fiat-denominated. The Buy/Sell consumers of the row
  // never read it on a convert (they read order_type first), and the
  // activity feed branches on order_type='convert' too.
  const dummyFiat: FiatCurrency =
    params.fromToken === "USDX" || params.toToken === "USDX"
      ? "USD"
      : params.fromToken === "EURX" || params.toToken === "EURX"
      ? "EUR"
      : params.fromToken === "GBPX" || params.toToken === "GBPX"
      ? "GBP"
      : params.fromToken === "BRLX" || params.toToken === "BRLX"
      ? "BRL"
      : "USD";

  await adminDb.execute<ResultSetHeader>(
    `INSERT INTO trade_orders (
      order_id, user_id, order_type, status,
      from_token, to_token, from_amount,
      fiat_currency, fiat_amount,
      max_slippage_bps,
      idempotency_key, ip_address, user_agent
    ) VALUES (?, ?, 'convert', 'executing', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      orderId,
      params.userId,
      params.fromToken,
      params.toToken,
      params.fromAmount.toFixed(18),
      dummyFiat,
      params.maxSlippageBps,
      params.idempotencyKey,
      params.ipAddress ?? null,
      params.userAgent ?? null,
    ]
  );
  return orderId;
}

async function finaliseConvertOrder(
  orderId: string,
  result: {
    txHash: string | null;
    toAmount: number;
    tusdAmount?: number | null;
    payoutSwapTxId?: string | null;
    debitTxId?: string | null;
    creditTxId?: string | null;
  }
): Promise<void> {
  await adminDb.execute(
    `UPDATE trade_orders SET
      status = 'completed',
      operator_tx_hash = ?,
      to_amount = ?,
      tusd_amount = ?,
      payout_swap_transaction_id = ?,
      debit_transaction_id = ?,
      credit_transaction_id = ?,
      executed_at = COALESCE(executed_at, NOW()),
      completed_at = NOW()
     WHERE order_id = ?`,
    [
      result.txHash,
      result.toAmount.toFixed(18),
      result.tusdAmount != null ? result.tusdAmount.toFixed(18) : null,
      result.payoutSwapTxId ?? null,
      result.debitTxId ?? null,
      result.creditTxId ?? null,
      orderId,
    ]
  );
}

async function failConvertOrder(
  orderId: string,
  status: OrderStatus,
  failureReason: string
): Promise<void> {
  await adminDb.execute(
    `UPDATE trade_orders SET
      status = ?,
      failure_reason = ?,
      completed_at = NOW()
     WHERE order_id = ?`,
    [status, redactPrivateKey(failureReason), orderId]
  );
}

export async function createConvertOrder(
  userId: string,
  fromToken: ConvertToken,
  toToken: ConvertToken,
  fromAmount: string,
  options?: {
    ipAddress?: string;
    userAgent?: string;
    idempotencyKey?: string;
  }
): Promise<ProcessResult> {
  const amount = parseFloat(fromAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid amount");
  }
  if (fromToken === toToken) {
    throw new Error("Cannot convert same token");
  }
  if (fromToken !== "PLAT" && toToken !== "PLAT") {
    throw new Error("Use the ledger swap path for stable↔stable conversions");
  }

  // Idempotency dedup — same pattern as createBuyOrder.
  const idempotencyKey = options?.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const [existing] = await db.execute<(RowDataPacket & TradeOrder)[]>(
      "SELECT * FROM trade_orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
      [userId, idempotencyKey]
    );
    if (existing.length > 0) {
      const row = existing[0];
      return {
        success: row.status === "completed",
        orderId: row.order_id,
        status: row.status,
        txHash: row.operator_tx_hash ?? undefined,
        tglobalAmount:
          fromToken === "PLAT"
            ? row.from_amount ?? undefined
            : toToken === "PLAT"
            ? row.to_amount ?? undefined
            : undefined,
        error: row.failure_reason ?? undefined,
      };
    }
  }

  // Confirm the user actually has the source balance before doing any
  // on-chain work. The eventual debit will re-check under a row lock.
  const sourceBalance = await getUserBalance(userId, fromToken);
  if (parseFloat(sourceBalance) < amount) {
    throw new Error(
      `Insufficient ${fromToken} balance. Have: ${parseFloat(sourceBalance).toFixed(
        4
      )}, Need: ${amount.toFixed(4)}`
    );
  }

  const maxSlippageBps = getMaxSlippageBps();
  const orderId = await insertConvertOrderRow({
    userId,
    fromToken,
    toToken,
    fromAmount: amount,
    maxSlippageBps,
    idempotencyKey,
    ipAddress: options?.ipAddress,
    userAgent: options?.userAgent,
  });

  try {
    // Resolve the user's smart account once — needed for AMM event
    // attribution. Falls back to operator address when not provisioned
    // (mirrors processSellOrder).
    const [operatorAddress, userSmartAccount] = await Promise.all([
      getOperatorSmartAccountAddress(),
      getSmartAccountAddressForUser(userId),
    ]);
    const userAddress = userSmartAccount || operatorAddress;

    // Dispatch on direction. Each branch returns the final to_amount in
    // the user's chosen target token + any tx/transaction ids worth
    // persisting.
    if (fromToken === "USDX" && toToken === "PLAT") {
      return await runUsdxToPlat(
        orderId,
        userId,
        amount,
        userAddress,
        maxSlippageBps
      );
    }
    if (fromToken === "PLAT" && toToken === "USDX") {
      return await runPlatToUsdx(
        orderId,
        userId,
        amount,
        userAddress,
        maxSlippageBps
      );
    }
    if (isStable(fromToken) && toToken === "PLAT") {
      return await runStableToPlat(
        orderId,
        userId,
        fromToken,
        amount,
        userAddress,
        maxSlippageBps
      );
    }
    if (fromToken === "PLAT" && isStable(toToken)) {
      return await runPlatToStable(
        orderId,
        userId,
        toToken,
        amount,
        userAddress,
        maxSlippageBps
      );
    }
    throw new Error(`Unsupported convert direction: ${fromToken} → ${toToken}`);
  } catch (err) {
    const msg = formatTradeExecutionError(err);
    await failConvertOrder(orderId, "failed", msg).catch(() => {});
    return {
      success: false,
      orderId,
      status: "failed",
      error: msg,
    };
  }
}

// ── Direction processors ───────────────────────────────────────────────

async function runUsdxToPlat(
  orderId: string,
  userId: string,
  amount: number,
  userAddress: string,
  maxSlippageBps: number
): Promise<ProcessResult> {
  // 1. Debit user's USDX ledger up front.
  const debit = await debitBalance(userId, "USDX", amount.toFixed(18), {
    notes: `Convert order ${orderId} debit (USDX)`,
    createdBy: "convert",
    idempotencyKey: `convert:${orderId}:debit`,
  });

  try {
    // 2. Quote + min-out + operator AMM swap.
    const ammQuote = await quoteSwap(false, parseUnits(amount.toFixed(18), 18));
    const expectedOut = parseFloat(ammQuote.amountOut);
    const minOut = (expectedOut * (1 - maxSlippageBps / 10_000)).toFixed(18);

    const swap = await executeOperatorBuy(amount.toFixed(18), minOut, userAddress);

    // 3. Credit PLAT.
    const credit = await creditBalance(
      userId,
      "PLAT",
      expectedOut.toFixed(18),
      {
        txHash: swap.txHash,
        notes: `Convert order ${orderId} credit (PLAT)`,
        createdBy: "convert",
        idempotencyKey: `convert:${orderId}:credit`,
      }
    );

    await finaliseConvertOrder(orderId, {
      txHash: swap.txHash,
      toAmount: expectedOut,
      tusdAmount: amount,
      debitTxId: debit.transactionId,
      creditTxId: credit.transactionId,
    });

    return {
      success: true,
      orderId,
      status: "completed",
      txHash: swap.txHash,
      tglobalAmount: expectedOut.toFixed(18),
    };
  } catch (err) {
    // Refund: credit USDX back.
    await creditBalance(userId, "USDX", amount.toFixed(18), {
      notes: `Convert order ${orderId} refund (AMM failed)`,
      createdBy: "convert",
      idempotencyKey: `convert:${orderId}:refund`,
    }).catch(() => {});
    throw err;
  }
}

async function runPlatToUsdx(
  orderId: string,
  userId: string,
  amount: number,
  userAddress: string,
  maxSlippageBps: number
): Promise<ProcessResult> {
  // 1. Debit user's PLAT ledger.
  const debit = await debitBalance(userId, "PLAT", amount.toFixed(18), {
    notes: `Convert order ${orderId} debit (PLAT)`,
    createdBy: "convert",
    idempotencyKey: `convert:${orderId}:debit`,
  });

  try {
    // 2. Quote + min-out + operator AMM swap.
    const ammQuote = await quoteSwap(true, parseUnits(amount.toFixed(18), 18));
    const expectedOut = parseFloat(ammQuote.amountOut);
    const minOut = (expectedOut * (1 - maxSlippageBps / 10_000)).toFixed(18);

    // Operator liquidity guard — same precondition as Sell.
    const opBalances = await getOperatorBalances();
    if (parseFloat(opBalances.tglobal) < amount) {
      throw new Error(
        `Operator insufficient PLAT. Need: ${amount}, Have: ${opBalances.tglobal}`
      );
    }

    const swap = await executeOperatorSell(
      amount.toFixed(18),
      minOut,
      userAddress
    );

    // 3. Credit USDX.
    const credit = await creditBalance(
      userId,
      "USDX",
      expectedOut.toFixed(18),
      {
        txHash: swap.txHash,
        notes: `Convert order ${orderId} credit (USDX)`,
        createdBy: "convert",
        idempotencyKey: `convert:${orderId}:credit`,
      }
    );

    await finaliseConvertOrder(orderId, {
      txHash: swap.txHash,
      toAmount: expectedOut,
      tusdAmount: expectedOut,
      debitTxId: debit.transactionId,
      creditTxId: credit.transactionId,
    });

    return {
      success: true,
      orderId,
      status: "completed",
      txHash: swap.txHash,
      tusdAmount: expectedOut.toFixed(18),
    };
  } catch (err) {
    // Refund: credit PLAT back.
    await creditBalance(userId, "PLAT", amount.toFixed(18), {
      notes: `Convert order ${orderId} refund (AMM failed)`,
      createdBy: "convert",
      idempotencyKey: `convert:${orderId}:refund`,
    }).catch(() => {});
    throw err;
  }
}

async function runStableToPlat(
  orderId: string,
  userId: string,
  fromToken: StableToken,
  amount: number,
  userAddress: string,
  maxSlippageBps: number
): Promise<ProcessResult> {
  if (fromToken === "USDX") {
    throw new Error("runStableToPlat: USDX should use runUsdxToPlat");
  }
  // 1. Ledger swap source → USDX (Chainlink rate, no processing fee).
  const ledgerLeg = await executeSwap(
    userId,
    fromToken,
    "USDX",
    amount.toFixed(18),
    {
      notes: `Convert order ${orderId} leg 1 (${fromToken} → USDX)`,
      skipProcessingFee: true,
    }
  );
  const usdxAmount = parseFloat(ledgerLeg.toAmount);

  try {
    // 2. Quote + min-out + operator AMM USDX → PLAT.
    const ammQuote = await quoteSwap(
      false,
      parseUnits(usdxAmount.toFixed(18), 18)
    );
    const expectedOut = parseFloat(ammQuote.amountOut);
    const minOut = (expectedOut * (1 - maxSlippageBps / 10_000)).toFixed(18);

    // 3. Debit the just-credited USDX before running the AMM, so the
    //    user's ledger doesn't show a transient inflated USDX balance.
    //    On AMM failure we refund via the reverse ledger swap below
    //    (atomic feel — source token is what comes back).
    const debit = await debitBalance(userId, "USDX", usdxAmount.toFixed(18), {
      notes: `Convert order ${orderId} leg 2 debit (USDX)`,
      createdBy: "convert",
      idempotencyKey: `convert:${orderId}:debit`,
    });

    const swap = await executeOperatorBuy(
      usdxAmount.toFixed(18),
      minOut,
      userAddress
    );

    const credit = await creditBalance(
      userId,
      "PLAT",
      expectedOut.toFixed(18),
      {
        txHash: swap.txHash,
        notes: `Convert order ${orderId} credit (PLAT)`,
        createdBy: "convert",
        idempotencyKey: `convert:${orderId}:credit`,
      }
    );

    await finaliseConvertOrder(orderId, {
      txHash: swap.txHash,
      toAmount: expectedOut,
      tusdAmount: usdxAmount,
      payoutSwapTxId: ledgerLeg.transactionId,
      debitTxId: debit.transactionId,
      creditTxId: credit.transactionId,
    });

    return {
      success: true,
      orderId,
      status: "completed",
      txHash: swap.txHash,
      tglobalAmount: expectedOut.toFixed(18),
    };
  } catch (err) {
    // Atomic refund: reverse the ledger leg so the user gets the source
    // token back instead of being stranded with USDX. Runs with
    // skipProcessingFee so the round-trip is free.
    await executeSwap(userId, "USDX", fromToken, usdxAmount.toFixed(18), {
      notes: `Convert order ${orderId} refund (AMM failed)`,
      skipProcessingFee: true,
    }).catch(() => {});
    throw err;
  }
}

async function runPlatToStable(
  orderId: string,
  userId: string,
  toToken: StableToken,
  amount: number,
  userAddress: string,
  maxSlippageBps: number
): Promise<ProcessResult> {
  if (toToken === "USDX") {
    throw new Error("runPlatToStable: USDX should use runPlatToUsdx");
  }
  // 1. Debit user's PLAT ledger.
  const debit = await debitBalance(userId, "PLAT", amount.toFixed(18), {
    notes: `Convert order ${orderId} debit (PLAT)`,
    createdBy: "convert",
    idempotencyKey: `convert:${orderId}:debit`,
  });

  let ammSucceeded = false;
  let usdxOut = 0;
  let swapTxHash: string | null = null;

  try {
    // 2. Quote + min-out + operator AMM PLAT → USDX.
    const ammQuote = await quoteSwap(true, parseUnits(amount.toFixed(18), 18));
    const expectedOut = parseFloat(ammQuote.amountOut);
    const minOut = (expectedOut * (1 - maxSlippageBps / 10_000)).toFixed(18);

    const opBalances = await getOperatorBalances();
    if (parseFloat(opBalances.tglobal) < amount) {
      throw new Error(
        `Operator insufficient PLAT. Need: ${amount}, Have: ${opBalances.tglobal}`
      );
    }

    const swap = await executeOperatorSell(
      amount.toFixed(18),
      minOut,
      userAddress
    );
    ammSucceeded = true;
    swapTxHash = swap.txHash;
    usdxOut = expectedOut;

    // 3. Credit USDX intermediate, then ledger-swap to the chosen
    //    stable. We materialise the USDX ledger entry (rather than
    //    skipping it) so the second leg is a normal executeSwap call —
    //    matches the pattern processSellOrder uses for non-USD payouts.
    const usdxCredit = await creditBalance(
      userId,
      "USDX",
      usdxOut.toFixed(18),
      {
        txHash: swap.txHash,
        notes: `Convert order ${orderId} leg 1 credit (USDX)`,
        createdBy: "convert",
        idempotencyKey: `convert:${orderId}:tusd`,
      }
    );

    // 4. Ledger swap USDX → target stable (no processing fee).
    const ledgerLeg = await executeSwap(
      userId,
      "USDX",
      toToken,
      usdxOut.toFixed(18),
      {
        notes: `Convert order ${orderId} leg 2 (USDX → ${toToken})`,
        skipProcessingFee: true,
      }
    );
    const finalAmount = parseFloat(ledgerLeg.toAmount);

    await finaliseConvertOrder(orderId, {
      txHash: swap.txHash,
      toAmount: finalAmount,
      tusdAmount: usdxOut,
      payoutSwapTxId: ledgerLeg.transactionId,
      debitTxId: debit.transactionId,
      creditTxId: usdxCredit.transactionId,
    });

    return {
      success: true,
      orderId,
      status: "completed",
      txHash: swap.txHash,
      tusdAmount: usdxOut.toFixed(18),
      payoutAmount: finalAmount.toFixed(18),
    };
  } catch (err) {
    if (!ammSucceeded) {
      // AMM failed — refund the PLAT debit and bail.
      await creditBalance(userId, "PLAT", amount.toFixed(18), {
        notes: `Convert order ${orderId} refund (AMM failed)`,
        createdBy: "convert",
        idempotencyKey: `convert:${orderId}:refund`,
      }).catch(() => {});
      throw err;
    }
    // AMM succeeded but the ledger second leg failed (vanishingly rare —
    // executeSwap is a pure DB op). We can't unwind the AMM, so we leave
    // the user with the credited USDX and surface a slippage_fallback-
    // style outcome. The trade_orders row is updated to reflect the
    // partial completion so support can see what happened.
    await adminDb.execute(
      `UPDATE trade_orders SET
        status = 'slippage_fallback',
        operator_tx_hash = ?,
        tusd_amount = ?,
        failure_reason = ?,
        completed_at = NOW()
       WHERE order_id = ?`,
      [
        swapTxHash,
        usdxOut.toFixed(18),
        `Convert second leg failed; user credited with ${usdxOut.toFixed(
          4
        )} USDX instead of ${toToken}.`,
        orderId,
      ]
    );
    return {
      success: false,
      orderId,
      status: "slippage_fallback",
      txHash: swapTxHash ?? undefined,
      tusdAmount: usdxOut.toFixed(18),
      error: `Conversion partially completed — your USDX has been credited. Convert again to reach ${toToken}.`,
    };
  }
}
