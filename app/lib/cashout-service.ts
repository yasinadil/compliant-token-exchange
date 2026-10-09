// app/lib/cashout-service.ts
// Cashout (off-ramp): internal ledger -> Transak SELL -> fiat

import crypto from "crypto";
import { db, adminDb } from "./db";
import { debitBalance, getUserBalance, creditBalance } from "./ledger-service";
import { getTokenUSDRate } from "./chainlink-service";
import { quoteSwap } from "./amm-service";
import {
  executeOperatorSell,
  getOperatorBalances,
  getOperatorSmartAccountAddress,
  getMaxSlippageBps,
} from "./operator-service";
import { getSmartAccountAddressForUser } from "./wallet-service";
import { redactPrivateKey } from "./platform-wallet-service";
import type { FiatCurrency, BankDetails } from "./payment-service";
import { parseUnits, formatUnits, isAddress } from "viem";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import {
  createOffRampWidgetUrl,
  getOffRampCryptoConfig,
  fetchTransakOrderByPartnerOrderId,
  getTransakSellQuote,
  type TransakWebhookPayload,
  type TransakOrderData,
} from "./transak-service";
import { estimateOffRampFee } from "./transak-limits";
import { sendCryptoFromTreasury, getTreasuryCryptoBalance } from "./treasury-service";
import { getTransakKYCPrefill } from "./kyc-helper";

export type CashoutToken = "USDX" | "GBPX" | "EURX" | "BRLX" | "PLAT";

export type CashoutStatus =
  | "processing"
  | "pending_payout"
  | "payout_sent"
  | "awaiting_transak"
  | "crypto_sent"
  | "completed"
  | "failed";

export interface CashoutOrder {
  id: number;
  cashout_id: string;
  user_id: string;
  token: CashoutToken;
  token_amount: string;
  tusd_amount: string;
  conversion_rate: string;
  amm_executed_price: string | null;
  amm_slippage_bps: number;
  operator_tx_hash: string | null;
  fiat_currency: string;
  fiat_amount: string;
  status: CashoutStatus;
  bank_details_encrypted: string | null;
  debit_transaction_id: string | null;
  payment_reference: string | null;
  processed_by: string | null;
  processed_at: string | null;
  process_notes: string | null;
  failure_reason: string | null;
  transak_order_id: string | null;
  transak_deposit_address: string | null;
  crypto_send_amount: string | null;
  treasury_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

// Platform/PLAT Investment fee taken on top of Transak's own fees. Currently
// disabled (0 = not charged, not shown in the UI). Set to a non-zero percent
// to re-enable across the cashout flow — the CashoutForm auto-shows/hides
// the fee line based on whether it's > 0, so no UI change is needed.
const PLATFORM_FEE_PCT = 0;
const MIN_SELL_USD = 10.5;

export interface CashoutQuote {
  token: CashoutToken;
  tokenAmount: string;
  tusdEquivalent: string;
  conversionRate: number;
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  transakFeePct: number;
  transakFeeAmount: string;
  transakFeeBreakdown: { name: string; value: number }[];
  platformFeePct: number;
  platformFeeAmount: string;
  totalFees: string;
  netReceive: string;
  minSellUsd: number;
  ammDetails?: {
    spotPrice: string;
    effectivePrice: string;
    priceImpactBps: number;
    feeAmount: string;
  };
  expiresAt: Date;
}

function generateCashoutId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function tusdToCryptoSendAmount(tusdStr: string): string {
  const n = parseFloat(tusdStr);
  if (isNaN(n) || n <= 0) throw new Error("Invalid USDX amount");
  const cfg = getOffRampCryptoConfig();
  if (cfg.isProduction) {
    return n.toFixed(6);
  }
  return n.toFixed(18);
}

function cryptoSendToWei(amountStr: string): bigint {
  const cfg = getOffRampCryptoConfig();
  return parseUnits(amountStr as `${number}`, cfg.decimals);
}

// ============================================================================
// QUOTES
// ============================================================================

interface TransakSellFeeInfo {
  feePct: number;
  feeAmount: number;
  feeBreakdown: { name: string; value: number }[];
}

/**
 * Fetch real Transak SELL fees via their pricing API.
 * Falls back to `estimateOffRampFee` (payment-method-aware fee schedule
 * from transak-limits.ts) when the API is unreachable or returns an error.
 */
/**
 * Net fiat the user should receive after Transak (+ platform) fees.
 * `tusdAmount` is the USDX/USDC value sent to Transak (pre-fee gross).
 */
/**
 * Fiat amount to show as "received" for a cashout. Legacy rows stored gross
 * USDX (≈ tusd_amount) in fiat_amount; derive net via Transak fee quote.
 * Newer rows already store net (fiat < tusd).
 */
export async function resolveCashoutDisplayFiat(
  fiatAmountStr: string,
  tusdAmountStr: string,
  fiatCurrency: FiatCurrency
): Promise<number> {
  const fiat = parseFloat(fiatAmountStr || "0");
  const tusd = parseFloat(tusdAmountStr || "0");
  if (!Number.isFinite(fiat) || fiat <= 0) return 0;
  // Net already persisted — fiat is materially below the gross tusd sent.
  if (tusd > 0 && fiat < tusd - 0.5) return fiat;
  // Legacy gross row: re-quote net from the tusd/crypto leg.
  if (tusd > 0) {
    return parseFloat(await computeNetFiatPayout(tusd, fiatCurrency));
  }
  return fiat;
}

async function computeNetFiatPayout(
  tusdAmount: number,
  fiatCurrency: FiatCurrency
): Promise<string> {
  let grossFiat = tusdAmount;
  if (fiatCurrency !== "USD") {
    const tokenMap: Record<string, string> = { GBP: "GBPX", EUR: "EURX", BRL: "BRLX" };
    const tokenSymbol = tokenMap[fiatCurrency];
    if (tokenSymbol) {
      const { rate } = await getTokenUSDRate(tokenSymbol);
      grossFiat = tusdAmount / rate;
    }
  }
  const transakFees = await getTransakSellFees(fiatCurrency, tusdAmount, grossFiat);
  const platformFee = grossFiat * (PLATFORM_FEE_PCT / 100);
  const net = grossFiat - transakFees.feeAmount - platformFee;
  return Math.max(0, net).toFixed(2);
}

async function getTransakSellFees(
  fiatCurrency: string,
  cryptoAmount: number,
  fiatAmountEstimate: number
): Promise<TransakSellFeeInfo> {
  try {
    const tq = await getTransakSellQuote(fiatCurrency, cryptoAmount);
    const feePct = tq.feeDecimal > 0
      ? tq.feeDecimal * 100
      : (fiatAmountEstimate > 0 ? (tq.totalFee / fiatAmountEstimate) * 100 : 0);
    return {
      feePct: Math.round(feePct * 100) / 100,
      feeAmount: tq.totalFee,
      feeBreakdown: tq.feeBreakdown.map((f) => ({ name: f.name, value: f.value })),
    };
  } catch (err) {
    console.warn("[Cashout] Transak SELL quote unavailable, using fallback:", err);
    const fallback = estimateOffRampFee(fiatAmountEstimate, fiatCurrency);
    return {
      feePct: fallback.feePct,
      feeAmount: fallback.totalFee,
      feeBreakdown: [],
    };
  }
}

export async function getCashoutQuote(
  token: CashoutToken,
  amount: string,
  fiatCurrency: FiatCurrency = "USD"
): Promise<CashoutQuote> {
  const tokenAmount = parseFloat(amount);
  if (isNaN(tokenAmount) || tokenAmount <= 0) throw new Error("Invalid amount");

  if (token === "PLAT") {
    const tglobalInWei = parseUnits(tokenAmount.toFixed(18), 18);
    const ammQuote = await quoteSwap(true, tglobalInWei);
    const tusdOut = parseFloat(ammQuote.amountOut);

    let fiatAmount = tusdOut;
    let conversionRate = 1;

    if (fiatCurrency !== "USD") {
      const tokenMap: Record<string, string> = { GBP: "GBPX", EUR: "EURX", BRL: "BRLX" };
      const tokenSymbol = tokenMap[fiatCurrency];
      if (tokenSymbol) {
        const { rate } = await getTokenUSDRate(tokenSymbol);
        fiatAmount = tusdOut / rate;
        conversionRate = rate;
      }
    }

    const transakFees = await getTransakSellFees(fiatCurrency, tusdOut, fiatAmount);
    const platformFee = fiatAmount * (PLATFORM_FEE_PCT / 100);
    const net = fiatAmount - transakFees.feeAmount - platformFee;

    return {
      token,
      tokenAmount: amount,
      tusdEquivalent: tusdOut.toFixed(6),
      conversionRate,
      fiatCurrency,
      fiatAmount: fiatAmount.toFixed(2),
      transakFeePct: transakFees.feePct,
      transakFeeAmount: transakFees.feeAmount.toFixed(2),
      transakFeeBreakdown: transakFees.feeBreakdown,
      platformFeePct: PLATFORM_FEE_PCT,
      platformFeeAmount: platformFee.toFixed(2),
      totalFees: (transakFees.feeAmount + platformFee).toFixed(2),
      netReceive: net.toFixed(2),
      minSellUsd: MIN_SELL_USD,
      ammDetails: {
        spotPrice: ammQuote.spotPrice,
        effectivePrice: ammQuote.effectivePrice,
        priceImpactBps: ammQuote.priceImpactBps,
        feeAmount: ammQuote.feeAmount,
      },
      expiresAt: new Date(Date.now() + 30000),
    };
  }

  let tusdEquivalent: number;
  let conversionRate: number;

  if (token === "USDX") {
    tusdEquivalent = tokenAmount;
    conversionRate = 1;
  } else {
    const { rate } = await getTokenUSDRate(token);
    tusdEquivalent = tokenAmount * rate;
    conversionRate = rate;
  }

  let fiatAmount = tusdEquivalent;
  if (fiatCurrency !== "USD") {
    const tokenMap: Record<string, string> = { GBP: "GBPX", EUR: "EURX", BRL: "BRLX" };
    const tokenSymbol = tokenMap[fiatCurrency];
    if (tokenSymbol) {
      const { rate } = await getTokenUSDRate(tokenSymbol);
      fiatAmount = tusdEquivalent / rate;
    }
  }

  const transakFees = await getTransakSellFees(fiatCurrency, tusdEquivalent, fiatAmount);
  const platformFee = fiatAmount * (PLATFORM_FEE_PCT / 100);
  const net = fiatAmount - transakFees.feeAmount - platformFee;

  return {
    token,
    tokenAmount: amount,
    tusdEquivalent: tusdEquivalent.toFixed(6),
    conversionRate,
    fiatCurrency,
    fiatAmount: fiatAmount.toFixed(2),
    transakFeePct: transakFees.feePct,
    transakFeeAmount: transakFees.feeAmount.toFixed(2),
    transakFeeBreakdown: transakFees.feeBreakdown,
    platformFeePct: PLATFORM_FEE_PCT,
    platformFeeAmount: platformFee.toFixed(2),
    totalFees: (transakFees.feeAmount + platformFee).toFixed(2),
    netReceive: net.toFixed(2),
    minSellUsd: MIN_SELL_USD,
    expiresAt: new Date(Date.now() + 30000),
  };
}

// ============================================================================
// LEGACY: manual bank payout (admin)
// ============================================================================

export async function createCashoutRequest(
  userId: string,
  token: CashoutToken,
  amount: string,
  fiatCurrency: FiatCurrency,
  bankDetails: BankDetails
): Promise<CashoutOrder> {
  const tokenAmount = parseFloat(amount);
  if (isNaN(tokenAmount) || tokenAmount <= 0) throw new Error("Invalid amount");

  const balance = await getUserBalance(userId, token);
  if (parseFloat(balance) < tokenAmount) {
    throw new Error(
      `Insufficient ${token} balance. Have: ${parseFloat(balance).toFixed(4)}, Need: ${tokenAmount.toFixed(4)}`
    );
  }

  const cashoutId = generateCashoutId();

  const debitResult = await debitBalance(userId, token, tokenAmount.toFixed(18), {
    notes: `Cashout ${cashoutId}`,
  });

  if (token === "PLAT") {
    return processTGlobalCashout(
      userId,
      cashoutId,
      tokenAmount,
      fiatCurrency,
      bankDetails,
      debitResult.transactionId
    );
  }

  let tusdEquivalent: number;
  let conversionRate: number;

  if (token === "USDX") {
    tusdEquivalent = tokenAmount;
    conversionRate = 1;
  } else {
    const { rate } = await getTokenUSDRate(token);
    tusdEquivalent = tokenAmount * rate;
    conversionRate = rate;
  }

  const fiatAmount = tusdEquivalent;

  await db.execute<ResultSetHeader>(
    `INSERT INTO cashout_orders (
      cashout_id, user_id, token, token_amount,
      tusd_amount, conversion_rate,
      fiat_currency, fiat_amount,
      status, bank_details_encrypted, debit_transaction_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_payout', ?, ?)`,
    [
      cashoutId,
      userId,
      token,
      tokenAmount.toFixed(18),
      tusdEquivalent.toFixed(18),
      conversionRate.toFixed(18),
      fiatCurrency,
      fiatAmount.toFixed(2),
      JSON.stringify(bankDetails),
      debitResult.transactionId,
    ]
  );

  return getCashoutByIdInternal(cashoutId);
}

async function processTGlobalCashout(
  userId: string,
  cashoutId: string,
  tokenAmount: number,
  fiatCurrency: FiatCurrency,
  bankDetails: BankDetails,
  debitTxId: string
): Promise<CashoutOrder> {
  await db.execute<ResultSetHeader>(
    `INSERT INTO cashout_orders (
      cashout_id, user_id, token, token_amount,
      tusd_amount, conversion_rate,
      fiat_currency, fiat_amount,
      status, bank_details_encrypted, debit_transaction_id
    ) VALUES (?, ?, 'PLAT', ?, 0, 0, ?, 0, 'processing', ?, ?)`,
    [cashoutId, userId, tokenAmount.toFixed(18), fiatCurrency, JSON.stringify(bankDetails), debitTxId]
  );

  try {
    const tglobalInWei = parseUnits(tokenAmount.toFixed(18), 18);
    const ammQuote = await quoteSwap(true, tglobalInWei);

    const opBalances = await getOperatorBalances();
    if (parseFloat(opBalances.tglobal) < tokenAmount) {
      throw new Error(
        `Operator insufficient PLAT. Need: ${tokenAmount}, Have: ${opBalances.tglobal}`
      );
    }

    const amountOut = parseFloat(ammQuote.amountOut);
    const maxSlippage = getMaxSlippageBps();
    const slippageFactor = 1 - maxSlippage / 10000;
    const minOut = (amountOut * slippageFactor).toFixed(18);

    const [operatorAddr, userSmartAccount] = await Promise.all([
      getOperatorSmartAccountAddress(),
      getSmartAccountAddressForUser(userId),
    ]);
    const userAddress = userSmartAccount || operatorAddr;

    const swapResult = await executeOperatorSell(tokenAmount.toFixed(18), minOut, userAddress);

    const tusdReceived = parseFloat(ammQuote.amountOut);
    const fiatAmount = tusdReceived;

    await db.execute(
      `UPDATE cashout_orders SET
        status = 'pending_payout',
        tusd_amount = ?,
        conversion_rate = 1,
        amm_executed_price = ?,
        amm_slippage_bps = ?,
        operator_tx_hash = ?,
        fiat_amount = ?
      WHERE cashout_id = ?`,
      [
        ammQuote.amountOut,
        ammQuote.effectivePrice,
        ammQuote.priceImpactBps,
        swapResult.txHash,
        fiatAmount.toFixed(2),
        cashoutId,
      ]
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";

    try {
      await creditBalance(userId, "PLAT", tokenAmount.toFixed(18), {
        notes: `Cashout ${cashoutId} failed, refunding PLAT`,
        createdBy: "operator",
        type: "adjustment",
      });
    } catch (refundError) {
      console.error("PLAT refund failed:", refundError);
    }

    await db.execute(
      "UPDATE cashout_orders SET status = 'failed', failure_reason = ? WHERE cashout_id = ?",
      [redactPrivateKey(msg), cashoutId]
    );
  }

  return getCashoutByIdInternal(cashoutId);
}

// ============================================================================
// TRANSAK OFF-RAMP
// ============================================================================

export interface InitiateTransakCashoutResult {
  cashoutId: string;
  widgetUrl: string;
  order: CashoutOrder;
}

/**
 * Debit user, convert to USDX notionally, create row awaiting_transak, return widget URL.
 */
export async function initiateCashoutWithTransak(
  userId: string,
  token: CashoutToken,
  amount: string,
  fiatCurrency: FiatCurrency,
  email?: string,
  options?: { idempotencyKey?: string }
): Promise<InitiateTransakCashoutResult> {
  const tokenAmount = parseFloat(amount);
  if (isNaN(tokenAmount) || tokenAmount <= 0) throw new Error("Invalid amount");

  // Client-supplied idempotency: if the UI submits the same cashout twice
  // (double-click, server-action retry during a DB blip, …) reuse the
  // existing row instead of debiting the user again.
  const idempotencyKey = options?.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const [existing] = await db.execute<(RowDataPacket & CashoutOrder)[]>(
      "SELECT * FROM cashout_orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
      [userId, idempotencyKey]
    );
    if (existing.length > 0) {
      const prior = existing[0];
      // Best-effort: re-issue the widget URL from the existing state. If the
      // prior URL already expired the user can just resubmit with a fresh
      // key.
      const kycPrefill = await getTransakKYCPrefill(userId);
      const cryptoAmt =
        prior.crypto_send_amount || tusdToCryptoSendAmount(prior.tusd_amount);
      const fiatNum = parseFloat(prior.fiat_amount || "0");
      const countryCode =
        process.env.TRANSAK_DEFAULT_COUNTRY_CODE ||
        process.env.NEXT_PUBLIC_TRANSAK_DEFAULT_COUNTRY ||
        "US";
      const widgetUrl = await createOffRampWidgetUrl({
        partnerOrderId: prior.cashout_id,
        partnerCustomerId: userId,
        fiatCurrency: prior.fiat_currency as FiatCurrency,
        cryptoAmount: cryptoAmt,
        fiatAmount: fiatNum > 0 ? fiatNum : undefined,
        countryCode,
        email: kycPrefill?.email ?? email,
        userData: kycPrefill?.userData,
      });
      return { cashoutId: prior.cashout_id, widgetUrl, order: prior };
    }
  }

  const preQuote = await getCashoutQuote(token, amount, fiatCurrency);
  if (parseFloat(preQuote.fiatAmount) < MIN_SELL_USD) {
    throw new Error(`Minimum cash out is $${MIN_SELL_USD.toFixed(2)} USD. Your amount is $${preQuote.fiatAmount}.`);
  }

  const balance = await getUserBalance(userId, token);
  if (parseFloat(balance) < tokenAmount) {
    throw new Error(
      `Insufficient ${token} balance. Have: ${parseFloat(balance).toFixed(4)}, Need: ${tokenAmount.toFixed(4)}`
    );
  }

  const { raw: treasuryBal, formatted: treasuryFmt } = await getTreasuryCryptoBalance();

  const cashoutId = generateCashoutId();
  const debitResult = await debitBalance(userId, token, tokenAmount.toFixed(18), {
    notes: `Transak cashout ${cashoutId}`,
  });

  if (token === "PLAT") {
    await db.execute<ResultSetHeader>(
      `INSERT INTO cashout_orders (
        cashout_id, user_id, token, token_amount,
        tusd_amount, conversion_rate,
        fiat_currency, fiat_amount,
        status, bank_details_encrypted, debit_transaction_id,
        idempotency_key
      ) VALUES (?, ?, 'PLAT', ?, 0, 0, ?, 0, 'processing', NULL, ?, ?)`,
      [
        cashoutId,
        userId,
        tokenAmount.toFixed(18),
        fiatCurrency,
        debitResult.transactionId,
        idempotencyKey,
      ]
    );

    try {
      const tglobalInWei = parseUnits(tokenAmount.toFixed(18), 18);
      const ammQuote = await quoteSwap(true, tglobalInWei);

      const opBalances = await getOperatorBalances();
      if (parseFloat(opBalances.tglobal) < tokenAmount) {
        throw new Error(
          `Operator insufficient PLAT. Need: ${tokenAmount}, Have: ${opBalances.tglobal}`
        );
      }

      const amountOut = parseFloat(ammQuote.amountOut);
      const maxSlippage = getMaxSlippageBps();
      const slippageFactor = 1 - maxSlippage / 10000;
      const minOut = (amountOut * slippageFactor).toFixed(18);

      const [operatorAddr, userSmartAccount] = await Promise.all([
        getOperatorSmartAccountAddress(),
        getSmartAccountAddressForUser(userId),
      ]);
      const userAddress = userSmartAccount || operatorAddr;

      const swapResult = await executeOperatorSell(tokenAmount.toFixed(18), minOut, userAddress);

      const tusdStr = ammQuote.amountOut;
      const cryptoSend = tusdToCryptoSendAmount(tusdStr);
      const needWei = cryptoSendToWei(cryptoSend);
      if (treasuryBal < needWei) {
        throw new Error(
          `Operator wallet low on ${getOffRampCryptoConfig().tokenSymbol} for off-ramp. Have ${treasuryFmt}, need at least ${formatUnits(needWei, getOffRampCryptoConfig().decimals)}`
        );
      }

      // Store net fiat payout (what Transak pays the user), not the gross
      // USDX value from the AMM — activity/history should match the sell UI.
      const netFiat = await computeNetFiatPayout(parseFloat(tusdStr), fiatCurrency);

      await db.execute(
        `UPDATE cashout_orders SET
          status = 'awaiting_transak',
          tusd_amount = ?,
          conversion_rate = 1,
          amm_executed_price = ?,
          amm_slippage_bps = ?,
          operator_tx_hash = ?,
          fiat_amount = ?,
          crypto_send_amount = ?
        WHERE cashout_id = ?`,
        [
          tusdStr,
          ammQuote.effectivePrice,
          ammQuote.priceImpactBps,
          swapResult.txHash,
          netFiat,
          cryptoSend,
          cashoutId,
        ]
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      try {
        await creditBalance(userId, "PLAT", tokenAmount.toFixed(18), {
          notes: `Transak cashout ${cashoutId} failed`,
          createdBy: "system",
          type: "adjustment",
        });
      } catch (e) {
        console.error(e);
      }
      await db.execute(
        "UPDATE cashout_orders SET status = 'failed', failure_reason = ? WHERE cashout_id = ?",
        [redactPrivateKey(msg), cashoutId]
      );
      throw error;
    }
  } else {
    let tusdEquivalent: number;
    let conversionRate: number;

    if (token === "USDX") {
      tusdEquivalent = tokenAmount;
      conversionRate = 1;
    } else {
      const { rate } = await getTokenUSDRate(token);
      tusdEquivalent = tokenAmount * rate;
      conversionRate = rate;
    }

    const tusdStr = tusdEquivalent.toFixed(18);
    const cryptoSend = tusdToCryptoSendAmount(tusdStr);
    const needWei = cryptoSendToWei(cryptoSend);
    if (treasuryBal < needWei) {
      await creditBalance(userId, token, tokenAmount.toFixed(18), {
        notes: `Transak cashout ${cashoutId} cancelled: operator liquidity`,
        type: "adjustment",
        createdBy: "system",
      });
      throw new Error(
        `Operator wallet low on ${getOffRampCryptoConfig().tokenSymbol}. Have ${treasuryFmt}`
      );
    }

    await db.execute<ResultSetHeader>(
      `INSERT INTO cashout_orders (
        cashout_id, user_id, token, token_amount,
        tusd_amount, conversion_rate,
        fiat_currency, fiat_amount,
        status, bank_details_encrypted, debit_transaction_id,
        crypto_send_amount, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_transak', NULL, ?, ?, ?)`,
      [
        cashoutId,
        userId,
        token,
        tokenAmount.toFixed(18),
        tusdEquivalent.toFixed(18),
        conversionRate.toFixed(18),
        fiatCurrency,
        preQuote.netReceive,
        debitResult.transactionId,
        cryptoSend,
        idempotencyKey,
      ]
    );
  }

  const [order, kycPrefill] = await Promise.all([
    getCashoutByIdInternal(cashoutId),
    getTransakKYCPrefill(userId),
  ]);
  const cryptoAmt = order.crypto_send_amount || tusdToCryptoSendAmount(order.tusd_amount);
  const fiatNum = parseFloat(order.fiat_amount || "0");
  const countryCode =
    process.env.TRANSAK_DEFAULT_COUNTRY_CODE ||
    process.env.NEXT_PUBLIC_TRANSAK_DEFAULT_COUNTRY ||
    "US";

  const widgetUrl = await createOffRampWidgetUrl({
    partnerOrderId: cashoutId,
    partnerCustomerId: userId,
    fiatCurrency,
    cryptoAmount: cryptoAmt,
    fiatAmount: fiatNum > 0 ? fiatNum : undefined,
    countryCode,
    email: kycPrefill?.email ?? email,
    userData: kycPrefill?.userData,
  });

  return { cashoutId, widgetUrl, order: await getCashoutByIdInternal(cashoutId) };
}

/**
 * After WALLET_REDIRECTION from Transak iframe: send on-chain crypto to deposit address.
 */
export async function processWalletRedirection(
  userId: string,
  cashoutId: string,
  depositAddress: string,
  transakOrderId: string
): Promise<CashoutOrder> {
  if (!isAddress(depositAddress)) {
    throw new Error("Invalid deposit address");
  }

  const order = await getCashoutByIdInternal(cashoutId);
  if (String(order.user_id) !== String(userId)) {
    throw new Error("Not authorized");
  }
  if (order.status !== "awaiting_transak") {
    if (order.status === "crypto_sent" || order.status === "completed") {
      return order;
    }
    throw new Error(`Cashout is not awaiting Transak: ${order.status}`);
  }

  if (order.treasury_tx_hash) {
    return order;
  }

  const cryptoStr = order.crypto_send_amount;
  if (!cryptoStr) {
    throw new Error("Missing crypto_send_amount on cashout order");
  }

  const amountWei = cryptoSendToWei(cryptoStr);

  // Atomic claim: eagerly flip status to 'crypto_sent' BEFORE the
  // blockchain send. This is the lock that prevents a concurrent
  // `userRefundAwaitingTransakCashout` (or any other refund path)
  // from crediting the user mid-flight — those refunds gate on
  // `WHERE status = 'awaiting_transak'` so once we win this UPDATE,
  // any racing cancel sees the row in 'crypto_sent' and aborts.
  //
  // Yes, this means the DB briefly reports 'crypto_sent' before the
  // crypto is actually on-chain (~a few seconds). That's acceptable
  // because (a) the alternative is a real-money double-pay race, and
  // (b) the revert path below restores 'awaiting_transak' if the send
  // throws so retries / manual recovery still work.
  const [claimRes] = await db.execute<ResultSetHeader>(
    `UPDATE cashout_orders SET
      transak_order_id = ?,
      transak_deposit_address = ?,
      status = 'crypto_sent'
    WHERE cashout_id = ? AND status = 'awaiting_transak'`,
    [transakOrderId, depositAddress, cashoutId]
  );
  if (claimRes.affectedRows === 0) {
    // Lost the race — refresh and return the current state so the
    // caller knows whether to surface success (already-processed) or
    // an error (cancelled).
    const fresh = await getCashoutByIdInternal(cashoutId);
    if (fresh.status === "crypto_sent" || fresh.status === "completed") {
      return fresh;
    }
    throw new Error(
      `Cashout was cancelled before crypto could be sent: ${fresh.status}`
    );
  }

  let txHash: string;
  try {
    const result = await sendCryptoFromTreasury(depositAddress, amountWei);
    txHash = result.txHash;
  } catch (sendErr) {
    // Revert the claim so the row is recoverable. Only revert if our
    // claim is still in place (no tx hash recorded yet) — guards
    // against re-entrant calls that may have already set it.
    try {
      await db.execute(
        `UPDATE cashout_orders SET
          status = 'awaiting_transak'
        WHERE cashout_id = ?
          AND status = 'crypto_sent'
          AND treasury_tx_hash IS NULL`,
        [cashoutId]
      );
    } catch (revertErr) {
      console.error(
        `[CRITICAL] Crypto send failed and claim revert also failed for cashout ${cashoutId}. Row is stuck in 'crypto_sent' without a tx hash — needs manual review.`,
        { sendErr, revertErr }
      );
    }
    throw sendErr;
  }

  await db.execute(
    `UPDATE cashout_orders SET
      treasury_tx_hash = ?
    WHERE cashout_id = ? AND treasury_tx_hash IS NULL`,
    [txHash, cashoutId]
  );

  return getCashoutByIdInternal(cashoutId);
}

export async function getCashoutOrderStatus(
  userId: string,
  cashoutId: string
): Promise<{
  status: CashoutStatus;
  treasuryTxHash: string | null;
  operatorTxHash: string | null;
  fiatAmount: string;
  failureReason: string | null;
}> {
  const order = await getCashoutByIdInternal(cashoutId);
  if (String(order.user_id) !== String(userId)) {
    throw new Error("Not authorized");
  }
  return {
    status: order.status,
    treasuryTxHash: order.treasury_tx_hash,
    operatorTxHash: order.operator_tx_hash,
    fiatAmount: order.fiat_amount,
    failureReason: order.failure_reason,
  };
}

// ============================================================================
// TRANSAK API POLLING (for localhost where webhooks can't reach)
// ============================================================================

const TRANSAK_STATUS_MAP: Record<string, CashoutStatus | null> = {
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "failed",
  REFUNDED: "failed",
  EXPIRED: "failed",
};

/**
 * Poll the Transak Partner API and sync status back to the local DB.
 * This bridges the gap on localhost where webhooks never arrive.
 * Called during frontend status polling so the UI always reflects reality.
 */
export async function syncCashoutStatusFromTransak(
  userId: string,
  cashoutId: string
): Promise<{
  status: CashoutStatus;
  treasuryTxHash: string | null;
  operatorTxHash: string | null;
  fiatAmount: string;
  failureReason: string | null;
}> {
  const order = await getCashoutByIdInternal(cashoutId);
  if (String(order.user_id) !== String(userId)) {
    throw new Error("Not authorized");
  }

  const terminalStatuses: CashoutStatus[] = ["completed", "failed"];

  let transakOrder: TransakOrderData | null = null;
  try {
    if (order.transak_order_id) {
      const { fetchTransakOrder } = await import("./transak-service");
      transakOrder = await fetchTransakOrder(order.transak_order_id);
    } else {
      transakOrder = await fetchTransakOrderByPartnerOrderId(cashoutId);
    }
  } catch (e) {
    console.warn("[syncCashoutStatus] Transak API fetch failed, returning local status:", e);
  }

  if (!transakOrder) {
    return {
      status: order.status,
      treasuryTxHash: order.treasury_tx_hash,
      operatorTxHash: order.operator_tx_hash,
      fiatAmount: order.fiat_amount,
      failureReason: order.failure_reason,
    };
  }

  if (transakOrder._id && !order.transak_order_id) {
    await db.execute(
      `UPDATE cashout_orders SET transak_order_id = ? WHERE cashout_id = ?`,
      [transakOrder._id, cashoutId]
    );
  }

  const transakStatus = transakOrder.status;

  if (
    order.status === "awaiting_transak" &&
    (transakStatus === "AWAITING_PAYMENT_FROM_USER" ||
      transakStatus === "PENDING_DELIVERY_FROM_TRANSAK" ||
      transakStatus === "PROCESSING" ||
      transakStatus === "COMPLETED")
  ) {
    const depositAddress = transakOrder.walletAddress;
    if (depositAddress && isAddress(depositAddress) && !order.treasury_tx_hash) {
      try {
        const cryptoStr = order.crypto_send_amount;
        if (cryptoStr) {
          // Atomic claim — same shape as `processWalletRedirection`.
          // Flip to `crypto_sent` before the on-chain send so any
          // racing cancel sees the row out of the refundable state.
          // If the claim returns 0 rows, the cashout was cancelled
          // between our read and now — abort without sending.
          const [claimRes] = await db.execute<ResultSetHeader>(
            `UPDATE cashout_orders SET
              transak_deposit_address = ?,
              status = 'crypto_sent'
            WHERE cashout_id = ? AND status = 'awaiting_transak'`,
            [depositAddress, cashoutId]
          );
          if (claimRes.affectedRows === 0) {
            console.log(`[syncCashoutStatus] Skipping auto-send for ${cashoutId}: no longer awaiting_transak`);
          } else {
            const amountWei = cryptoSendToWei(cryptoStr);
            let txHash: string;
            try {
              const result = await sendCryptoFromTreasury(depositAddress, amountWei);
              txHash = result.txHash;
            } catch (sendErr) {
              await db.execute(
                `UPDATE cashout_orders SET status = 'awaiting_transak'
                 WHERE cashout_id = ? AND status = 'crypto_sent' AND treasury_tx_hash IS NULL`,
                [cashoutId]
              ).catch((revertErr) => {
                console.error(
                  `[CRITICAL] syncCashoutStatus: crypto send failed and revert failed for ${cashoutId}`,
                  { sendErr, revertErr }
                );
              });
              throw sendErr;
            }
            await db.execute(
              `UPDATE cashout_orders SET treasury_tx_hash = ? WHERE cashout_id = ? AND treasury_tx_hash IS NULL`,
              [txHash, cashoutId]
            );
            console.log(`[syncCashoutStatus] Auto-sent crypto for ${cashoutId} -> tx: ${txHash}`);
          }
        }
      } catch (e) {
        console.error("[syncCashoutStatus] Auto-send crypto failed:", e);
      }
    }
  }

  const mappedStatus = TRANSAK_STATUS_MAP[transakStatus];
  if (mappedStatus === "completed") {
    const transakNetFiat =
      transakOrder.fiatAmount > 0 ? transakOrder.fiatAmount.toFixed(2) : null;
    await db.execute(
      `UPDATE cashout_orders SET
        status = 'completed',
        fiat_amount = COALESCE(?, fiat_amount),
        payment_reference = ?,
        processed_at = NOW(),
        process_notes = 'Transak off-ramp completed (synced via API poll)'
      WHERE cashout_id = ?`,
      [transakNetFiat, transakOrder._id, cashoutId]
    );
  } else if (mappedStatus === "failed") {
    const reason = transakStatus;
    try {
      const freshOrder = await getCashoutByIdInternal(cashoutId);
      if (freshOrder.status !== "failed") {
        const refundToken =
          freshOrder.token === "PLAT" && freshOrder.operator_tx_hash ? "USDX" : freshOrder.token;
        const refundAmount =
          freshOrder.token === "PLAT" && freshOrder.operator_tx_hash
            ? parseFloat(freshOrder.tusd_amount).toFixed(18)
            : parseFloat(freshOrder.token_amount).toFixed(18);
        await creditBalance(freshOrder.user_id, refundToken as CashoutToken, refundAmount, {
          notes: `Transak cashout ${cashoutId} ${transakStatus} (synced via API poll)`,
          type: "adjustment",
          createdBy: "transak-api-poll",
        });
      }
    } catch (e) {
      console.error("[syncCashoutStatus] Refund credit failed:", e);
    }

    await db.execute(
      `UPDATE cashout_orders SET
        status = 'failed',
        failure_reason = ?,
        processed_at = NOW()
      WHERE cashout_id = ? AND status NOT IN ('completed', 'failed')`,
      [redactPrivateKey(reason), cashoutId]
    );
  }

  const updated = await getCashoutByIdInternal(cashoutId);
  return {
    status: updated.status,
    treasuryTxHash: updated.treasury_tx_hash,
    operatorTxHash: updated.operator_tx_hash,
    fiatAmount: updated.fiat_amount,
    failureReason: updated.failure_reason,
  };
}

async function findCashoutForTransakWebhook(
  transakOrderId: string,
  partnerOrderId?: string
): Promise<CashoutOrder | null> {
  if (partnerOrderId) {
    const [byPartner] = await db.query<(RowDataPacket & CashoutOrder)[]>(
      "SELECT * FROM cashout_orders WHERE cashout_id = ? LIMIT 1",
      [partnerOrderId]
    );
    if (byPartner.length > 0) return byPartner[0] as CashoutOrder;
  }

  if (transakOrderId) {
    const [byTok] = await db.query<(RowDataPacket & CashoutOrder)[]>(
      "SELECT * FROM cashout_orders WHERE transak_order_id = ? LIMIT 1",
      [transakOrderId]
    );
    if (byTok.length > 0) return byTok[0] as CashoutOrder;
  }

  return null;
}

/**
 * Transak webhook for SELL orders tied to cashout_orders.
 */
export async function processCashoutTransakWebhook(
  payload: TransakWebhookPayload
): Promise<{ handled: boolean; success: boolean; message: string }> {
  const wd = payload.webhookData;
  const transakOrderId = wd.id;

  const order = await findCashoutForTransakWebhook(transakOrderId, wd.partnerOrderId);

  if (!order) {
    return { handled: false, success: false, message: "Not a cashout order" };
  }

  const status = wd.status;

  await db.execute(
    `UPDATE cashout_orders SET transak_order_id = ?, updated_at = NOW() WHERE cashout_id = ?`,
    [transakOrderId, order.cashout_id]
  );

  // Transak created the SELL order — deposit address available, auto-send crypto
  if (status === "AWAITING_PAYMENT_FROM_USER") {
    const depositAddress = wd.walletAddress;
    if (!depositAddress || !isAddress(depositAddress)) {
      console.error("[Cashout webhook] AWAITING_PAYMENT_FROM_USER but no valid walletAddress:", depositAddress);
      return { handled: true, success: false, message: "Missing deposit address" };
    }

    if (order.status !== "awaiting_transak") {
      console.log(`[Cashout webhook] Order ${order.cashout_id} already past awaiting_transak (${order.status}), skipping auto-send`);
      return { handled: true, success: true, message: `Already ${order.status}` };
    }
    if (order.treasury_tx_hash) {
      return { handled: true, success: true, message: "Crypto already sent" };
    }

    const cryptoStr = order.crypto_send_amount;
    if (!cryptoStr) {
      console.error("[Cashout webhook] Missing crypto_send_amount for", order.cashout_id);
      return { handled: true, success: false, message: "Missing crypto_send_amount" };
    }

    try {
      // Atomic claim — same shape as `processWalletRedirection`. The
      // webhook path runs concurrently with both the user-cancel
      // button and the redirect handler; this UPDATE is the lock.
      const [claimRes] = await db.execute<ResultSetHeader>(
        `UPDATE cashout_orders SET
          transak_deposit_address = ?,
          status = 'crypto_sent'
        WHERE cashout_id = ? AND status = 'awaiting_transak'`,
        [depositAddress, order.cashout_id]
      );
      if (claimRes.affectedRows === 0) {
        console.log(`[Cashout webhook] Skipping auto-send for ${order.cashout_id}: no longer awaiting_transak`);
        return { handled: true, success: true, message: "Already cancelled or processed" };
      }

      const amountWei = cryptoSendToWei(cryptoStr);
      let txHash: string;
      try {
        const result = await sendCryptoFromTreasury(depositAddress, amountWei);
        txHash = result.txHash;
      } catch (sendErr) {
        await db.execute(
          `UPDATE cashout_orders SET status = 'awaiting_transak'
           WHERE cashout_id = ? AND status = 'crypto_sent' AND treasury_tx_hash IS NULL`,
          [order.cashout_id]
        ).catch((revertErr) => {
          console.error(
            `[CRITICAL] Webhook: crypto send failed and revert failed for ${order.cashout_id}`,
            { sendErr, revertErr }
          );
        });
        throw sendErr;
      }

      await db.execute(
        `UPDATE cashout_orders SET treasury_tx_hash = ? WHERE cashout_id = ? AND treasury_tx_hash IS NULL`,
        [txHash, order.cashout_id]
      );
      console.log(`[Cashout webhook] Auto-sent ${cryptoStr} to ${depositAddress} (tx: ${txHash})`);
      return { handled: true, success: true, message: `Crypto sent: ${txHash}` };
    } catch (e) {
      console.error("[Cashout webhook] Auto-send failed:", e);
      return { handled: true, success: false, message: `Auto-send failed: ${e}` };
    }
  }

  if (status === "COMPLETED") {
    const transakNetFiat =
      wd.fiatAmount > 0 ? String(wd.fiatAmount) : null;
    await db.execute(
      `UPDATE cashout_orders SET
        status = 'completed',
        fiat_amount = COALESCE(?, fiat_amount),
        payment_reference = ?,
        processed_at = NOW(),
        process_notes = 'Transak off-ramp completed'
      WHERE cashout_id = ?`,
      [transakNetFiat, transakOrderId, order.cashout_id]
    );
    return { handled: true, success: true, message: "Cashout completed" };
  }

  if (
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "REFUNDED" ||
    status === "EXPIRED"
  ) {
    const reason = wd.statusReason || status;
    try {
      const refundToken =
        order.token === "PLAT" && order.operator_tx_hash ? "USDX" : order.token;
      const refundAmount =
        order.token === "PLAT" && order.operator_tx_hash
          ? parseFloat(order.tusd_amount).toFixed(18)
          : parseFloat(order.token_amount).toFixed(18);
      await creditBalance(order.user_id, refundToken as CashoutToken, refundAmount, {
        notes: `Transak cashout ${order.cashout_id} failed: ${reason}`,
        type: "adjustment",
        createdBy: "transak-webhook",
      });
    } catch (e) {
      console.error("[Cashout webhook] Refund credit failed:", e);
    }

    await db.execute(
      `UPDATE cashout_orders SET
        status = 'failed',
        failure_reason = ?,
        processed_at = NOW()
      WHERE cashout_id = ?`,
      [redactPrivateKey(reason), order.cashout_id]
    );
    return { handled: true, success: true, message: "Cashout marked failed" };
  }

  return { handled: true, success: true, message: `Cashout status ${status}` };
}

/**
 * Classifies Transak's actual order state for an `awaiting_transak`
 * cashout. Used as the gate by every refund path — without it, a refund
 * can fire while Transak has already committed to paying the user, which
 * is how the double-pay exploit (refund + Transak email) slipped through.
 *
 * Returned kinds:
 *   • `no_order`          — Transak has nothing for this cashout. Refund safe.
 *   • `terminal_failed`   — FAILED/CANCELLED/REFUNDED/EXPIRED on Transak's side.
 *                           Refund safe; Transak isn't paying the user.
 *   • `awaiting_user`     — AWAITING_PAYMENT_FROM_USER. The order exists on
 *                           Transak but they're waiting for crypto. User may
 *                           still be in the widget. Refund is safe in the
 *                           sense that our atomic claim then prevents the
 *                           operator wallet from sending crypto, so Transak
 *                           never pays.
 *   • `committed`         — PROCESSING / PENDING_DELIVERY_FROM_TRANSAK /
 *                           COMPLETED. Transak is paying or has paid the
 *                           user. Refunding here is a double-pay — refuse
 *                           and let the normal sync flow finish the sale.
 *   • `lookup_failed`     — API error or unreachable. We can't tell what
 *                           Transak thinks; conservatively refuse refunds.
 *
 * Reason for the strict gating: users could game the system by either
 * (a) taking >5 min in the widget so the stale-reconcile path
 * auto-refunded a still-active sale, or (b) clicking Cancel after Transak
 * had silently completed payment to their card. Both collapse if we ask
 * Transak what it thinks before crediting any refund.
 */
const TRANSAK_TERMINAL_FAILED_STATUSES = new Set([
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "EXPIRED",
]);
const TRANSAK_COMMITTED_STATUSES = new Set([
  "PROCESSING",
  "PENDING_DELIVERY_FROM_TRANSAK",
  "COMPLETED",
]);

export type TransakRefundCheck =
  | { kind: "no_order" }
  | { kind: "terminal_failed"; status: string }
  | { kind: "awaiting_user"; status: string }
  | { kind: "committed"; status: string }
  | { kind: "lookup_failed" };

export async function checkTransakRefundable(
  order: CashoutOrder
): Promise<TransakRefundCheck> {
  try {
    let transakOrder: TransakOrderData | null = null;
    if (order.transak_order_id) {
      const { fetchTransakOrder } = await import("./transak-service");
      transakOrder = await fetchTransakOrder(order.transak_order_id);
    } else {
      transakOrder = await fetchTransakOrderByPartnerOrderId(order.cashout_id);
    }
    if (!transakOrder) return { kind: "no_order" };
    const status = transakOrder.status;
    if (TRANSAK_TERMINAL_FAILED_STATUSES.has(status)) {
      return { kind: "terminal_failed", status };
    }
    if (TRANSAK_COMMITTED_STATUSES.has(status)) {
      return { kind: "committed", status };
    }
    if (status === "AWAITING_PAYMENT_FROM_USER") {
      return { kind: "awaiting_user", status };
    }
    // Anything we don't explicitly categorise — treat as committed for
    // safety. New Transak statuses should fail closed (no refund) until
    // we explicitly classify them.
    return { kind: "committed", status };
  } catch (err) {
    console.error(
      `[checkTransakRefundable] Lookup failed for cashout ${order.cashout_id}:`,
      err
    );
    return { kind: "lookup_failed" };
  }
}

/**
 * Convenience used by user-cancel + admin abandon paths. Throws a
 * user-meaningful error if the refund must be refused; returns void if
 * the refund is safe to proceed (the caller still does the atomic claim).
 */
function assertRefundAllowed(check: TransakRefundCheck): void {
  if (check.kind === "committed") {
    throw new Error(
      `Cannot cancel — Transak has already begun processing this sale (status: ${check.status}). Your tokens are on their way to becoming fiat in your bank. If this looks wrong, contact support.`
    );
  }
  if (check.kind === "lookup_failed") {
    throw new Error(
      "Couldn't verify your order status with Transak. Please try again in a moment."
    );
  }
}

/**
 * User cancelled before Transak deposit / closed widget — credit ledger back (same rules as admin abandon).
 * PLAT after AMM: refunds USDX; otherwise refunds original token amount.
 */
export async function userRefundAwaitingTransakCashout(
  userId: string,
  cashoutId: string
): Promise<void> {
  // Read first for the user-id authorization check + refund math. This
  // read is NOT the race guard — the conditional UPDATE below is. The
  // read can stale between here and the UPDATE; the UPDATE's WHERE
  // clause is what makes the operation safe.
  const order = await getCashoutByIdInternal(cashoutId);
  if (String(order.user_id) !== String(userId)) {
    throw new Error("Not authorized");
  }
  if (order.status !== "awaiting_transak") {
    throw new Error(
      "Only cashouts waiting on Transak can be cancelled. If funds were already sent on-chain, contact support."
    );
  }

  // Verify with Transak before crediting. Without this gate a user can
  // cancel AFTER Transak has already committed payment to their card —
  // the cancel credits a refund, Transak still pays the card, and the
  // platform eats the difference. See `checkTransakRefundable` for the
  // full rationale; throws a user-meaningful message via
  // `assertRefundAllowed` when refund must be refused.
  const transakCheck = await checkTransakRefundable(order);
  assertRefundAllowed(transakCheck);

  const refundToken =
    order.token === "PLAT" && order.operator_tx_hash ? "USDX" : order.token;
  const refundAmount =
    order.token === "PLAT" && order.operator_tx_hash
      ? parseFloat(order.tusd_amount).toFixed(18)
      : parseFloat(order.token_amount).toFixed(18);

  // Atomic claim: flip status='failed' ONLY if the row is still
  // 'awaiting_transak'. This is the lock that prevents a concurrent
  // `processWalletRedirection` from sending crypto after we've decided
  // to refund — its UPDATEs are also `WHERE status = 'awaiting_transak'`,
  // so once we win this row exits the contestable state and the
  // redirect handler will abort before `sendCryptoFromTreasury`.
  //
  // If `affectedRows === 0`, the redirect path won the race (status
  // already flipped to `crypto_sent` while we were preparing). Bail
  // without crediting — the user is getting the sale, not a refund.
  const [claimRes] = await db.execute<ResultSetHeader>(
    `UPDATE cashout_orders SET
      status = 'failed',
      failure_reason = ?,
      processed_by = ?,
      processed_at = NOW(),
      process_notes = ?
    WHERE cashout_id = ? AND status = 'awaiting_transak'`,
    [
      "Cancelled by user before Transak crypto deposit",
      userId,
      "User cancelled from cashout page",
      cashoutId,
    ]
  );
  if (claimRes.affectedRows === 0) {
    throw new Error(
      "Couldn't cancel — the sale has already been processed. If something looks wrong, contact support."
    );
  }

  // Status claim won. Credit the refund. If the credit throws we
  // revert the status back to 'awaiting_transak' so the user isn't
  // left with a failed-but-not-refunded row (either the redirect
  // handler can still complete the sale, or the user can retry the
  // cancel). This is best-effort recovery: if the revert itself
  // throws (extremely rare — same connection, same row), we surface
  // the original error and log loudly for manual intervention.
  try {
    await creditBalance(order.user_id, refundToken as CashoutToken, refundAmount, {
      notes: `User cancelled Transak cashout ${cashoutId}`,
      type: "adjustment",
      createdBy: userId,
    });
  } catch (creditErr) {
    try {
      await db.execute(
        `UPDATE cashout_orders SET
          status = 'awaiting_transak',
          failure_reason = NULL,
          processed_by = NULL,
          processed_at = NULL,
          process_notes = NULL
        WHERE cashout_id = ? AND status = 'failed'`,
        [cashoutId]
      );
    } catch (revertErr) {
      console.error(
        `[CRITICAL] Cancel claim succeeded but both credit and revert failed for cashout ${cashoutId}. User is owed a manual refund of ${refundAmount} ${refundToken}.`,
        { creditErr, revertErr }
      );
    }
    throw creditErr;
  }
}

export async function refundAbandonedCashout(
  cashoutId: string,
  adminUserId: string,
  notes: string
): Promise<void> {
  const order = await getCashoutByIdInternal(cashoutId);
  if (order.status !== "awaiting_transak") {
    throw new Error("Only awaiting_transak orders can be abandoned-refunded this way");
  }

  // Verify with Transak before crediting — same gate as the user-cancel
  // path. An admin "abandon" is functionally a forced cancel; the same
  // double-pay exploit applies if we don't check Transak's view first.
  const transakCheck = await checkTransakRefundable(order);
  assertRefundAllowed(transakCheck);

  const refundToken =
    order.token === "PLAT" && order.operator_tx_hash ? "USDX" : order.token;
  const refundAmount =
    order.token === "PLAT" && order.operator_tx_hash
      ? parseFloat(order.tusd_amount).toFixed(18)
      : parseFloat(order.token_amount).toFixed(18);

  // Atomic claim — see `userRefundAwaitingTransakCashout` for the
  // full rationale. If we lose the race to a `processWalletRedirection`
  // that's mid-send, we throw without crediting (the sale is going
  // through, no refund owed).
  const [claimRes] = await adminDb.execute<ResultSetHeader>(
    `UPDATE cashout_orders SET
      status = 'failed',
      failure_reason = ?,
      processed_by = ?,
      processed_at = NOW(),
      process_notes = ?
    WHERE cashout_id = ? AND status = 'awaiting_transak'`,
    [`Abandoned: ${notes}`, adminUserId, notes, cashoutId]
  );
  if (claimRes.affectedRows === 0) {
    throw new Error(
      `Cashout ${cashoutId} is no longer awaiting Transak — refund aborted`
    );
  }

  try {
    await creditBalance(order.user_id, refundToken as CashoutToken, refundAmount, {
      notes: `Admin refund abandoned cashout: ${notes}`,
      type: "adjustment",
      createdBy: adminUserId,
    });
  } catch (creditErr) {
    try {
      await adminDb.execute(
        `UPDATE cashout_orders SET
          status = 'awaiting_transak',
          failure_reason = NULL,
          processed_by = NULL,
          processed_at = NULL,
          process_notes = NULL
        WHERE cashout_id = ? AND status = 'failed'`,
        [cashoutId]
      );
    } catch (revertErr) {
      console.error(
        `[CRITICAL] Abandon-refund claim succeeded but both credit and revert failed for cashout ${cashoutId}. Owed ${refundAmount} ${refundToken}.`,
        { creditErr, revertErr }
      );
    }
    throw creditErr;
  }
}

/**
 * Refund a cashout that is in a safely-recoverable state — either
 * `pending_payout` (funds debited from user, no on-chain ops yet for
 * stables; AMM swap complete for PLAT) or `awaiting_transak` (Transak
 * session created but no crypto sent yet). In both cases the platform
 * still holds the funds (original token for stables, USDX for PLAT
 * post-swap), so we can fully restore the user's ledger.
 *
 * Does NOT handle `payout_sent` / `crypto_sent` — at those states the
 * operator wallet has already broadcast a transfer to Transak's deposit
 * address, so refunding the ledger without recovering the crypto would
 * mean paying the user twice. Those states need manual operator review.
 *
 * Used by the admin bulk-cancel testing utility so a stuck "pending"
 * backlog can be wiped without leaving users out-of-pocket.
 */
export async function refundCancellableCashout(
  cashoutId: string,
  adminUserId: string,
  notes: string
): Promise<void> {
  const order = await getCashoutByIdInternal(cashoutId);
  if (order.status !== "awaiting_transak" && order.status !== "pending_payout") {
    throw new Error(
      `Cashout ${cashoutId} is in status '${order.status}' — only 'awaiting_transak' and 'pending_payout' can be safely bulk-cancelled`
    );
  }

  // For awaiting_transak rows, verify with Transak before crediting.
  // pending_payout rows haven't yet been handed to Transak (the operator
  // hasn't set up the deposit address), so there's nothing for Transak
  // to check — skip the lookup.
  if (order.status === "awaiting_transak") {
    const transakCheck = await checkTransakRefundable(order);
    assertRefundAllowed(transakCheck);
  }

  const refundToken =
    order.token === "PLAT" && order.operator_tx_hash ? "USDX" : order.token;
  const refundAmount =
    order.token === "PLAT" && order.operator_tx_hash
      ? parseFloat(order.tusd_amount).toFixed(18)
      : parseFloat(order.token_amount).toFixed(18);

  // Atomic claim — same shape as the other refund paths. The status
  // change must happen BEFORE the credit so a concurrent
  // `processWalletRedirection` sees the row exit its refundable
  // states and aborts before sending crypto.
  const [claimRes] = await adminDb.execute<ResultSetHeader>(
    `UPDATE cashout_orders SET
      status = 'failed',
      failure_reason = ?,
      processed_by = ?,
      processed_at = NOW(),
      process_notes = ?
    WHERE cashout_id = ? AND status IN ('awaiting_transak', 'pending_payout')`,
    [`Bulk-cancelled: ${notes}`, adminUserId, notes, cashoutId]
  );
  if (claimRes.affectedRows === 0) {
    throw new Error(
      `Cashout ${cashoutId} is no longer in a refundable state — refund aborted`
    );
  }

  try {
    await creditBalance(order.user_id, refundToken as CashoutToken, refundAmount, {
      notes: `Admin bulk-cancel refund: ${notes}`,
      type: "adjustment",
      createdBy: adminUserId,
    });
  } catch (creditErr) {
    try {
      await adminDb.execute(
        `UPDATE cashout_orders SET
          status = ?,
          failure_reason = NULL,
          processed_by = NULL,
          processed_at = NULL,
          process_notes = NULL
        WHERE cashout_id = ? AND status = 'failed'`,
        [order.status, cashoutId]
      );
    } catch (revertErr) {
      console.error(
        `[CRITICAL] Bulk-cancel claim succeeded but both credit and revert failed for cashout ${cashoutId}. Owed ${refundAmount} ${refundToken}.`,
        { creditErr, revertErr }
      );
    }
    throw creditErr;
  }
}

// ============================================================================
// QUERIES
// ============================================================================

async function getCashoutByIdInternal(cashoutId: string): Promise<CashoutOrder> {
  const [rows] = await db.execute<(RowDataPacket & CashoutOrder)[]>(
    "SELECT * FROM cashout_orders WHERE cashout_id = ?",
    [cashoutId]
  );
  if (rows.length === 0) throw new Error(`Cashout not found: ${cashoutId}`);
  return rows[0] as CashoutOrder;
}

export async function getUserCashouts(
  userId: string,
  limit = 50,
  offset = 0
): Promise<CashoutOrder[]> {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const [rows] = await db.query<(RowDataPacket & CashoutOrder)[]>(
    `SELECT * FROM cashout_orders
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );
  return rows as CashoutOrder[];
}

export async function getAllCashouts(limit = 50, offset = 0): Promise<CashoutOrder[]> {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const [rows] = await adminDb.query<(RowDataPacket & CashoutOrder)[]>(
    `SELECT * FROM cashout_orders
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`
  );
  return rows as CashoutOrder[];
}

export async function getPendingCashouts(): Promise<CashoutOrder[]> {
  const [rows] = await adminDb.execute<(RowDataPacket & CashoutOrder)[]>(
    `SELECT * FROM cashout_orders
     WHERE status IN (
       'pending_payout',
       'payout_sent',
       'awaiting_transak',
       'crypto_sent'
     )
     ORDER BY created_at ASC`
  );
  return rows as CashoutOrder[];
}

export async function markCashoutCompleted(
  cashoutId: string,
  adminUserId: string,
  paymentReference: string,
  notes?: string
): Promise<void> {
  await adminDb.execute(
    `UPDATE cashout_orders SET
      status = 'completed',
      payment_reference = ?,
      processed_by = ?,
      processed_at = NOW(),
      process_notes = ?
    WHERE cashout_id = ?`,
    [paymentReference, adminUserId, notes ?? null, cashoutId]
  );
}

export async function markCashoutFailed(
  cashoutId: string,
  adminUserId: string,
  notes: string
): Promise<void> {
  await adminDb.execute(
    `UPDATE cashout_orders SET
      status = 'failed',
      processed_by = ?,
      processed_at = NOW(),
      process_notes = ?
    WHERE cashout_id = ?`,
    [adminUserId, notes, cashoutId]
  );
}

// ============================================================================
// AUTOMATIC RECONCILIATION
// ============================================================================

// Hard timeout for any in-flight order. After this window we assume the
// user has abandoned the flow (closed the Transak tab, lost popup, etc.)
// and force-close the order — but only after verifying with Transak that
// they aren't paying out the user (see `checkTransakRefundable`).
// Prevents the "ever-lasting pending" backlog.
const IN_FLIGHT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Automatically reconcile all awaiting_transak orders for a user.
 *
 * For each order:
 *  - If Transak has an order linked to it: delegate to
 *    `syncCashoutStatusFromTransak`, which auto-sends crypto for active
 *    orders and refunds on terminal failure.
 *  - If Transak's API returns null OR throws: do nothing. We used to
 *    auto-refund based purely on "no order found after 5 min", but that
 *    fired false positives whenever a user took a while in the Transak
 *    widget and Transak hadn't yet linked our partner_order_id — leaving
 *    them refunded AND with a real Transak payment to their card. The
 *    safe place for a "popup blocked / never opened" refund is now the
 *    user-cancel button (`userRefundAwaitingTransakCashout`), which
 *    independently checks Transak before crediting.
 *
 * Returns the number of orders whose status changed.
 */
export async function reconcileStaleAwaitingOrders(
  userId: string
): Promise<number> {
  const [rows] = await db.query<(RowDataPacket & CashoutOrder)[]>(
    `SELECT * FROM cashout_orders WHERE user_id = ? AND status = 'awaiting_transak' ORDER BY created_at ASC`,
    [userId]
  );

  if (rows.length === 0) return 0;

  let reconciled = 0;

  for (const order of rows) {
    try {
      let transakOrder: TransakOrderData | null = null;
      try {
        if (order.transak_order_id) {
          const { fetchTransakOrder } = await import("./transak-service");
          transakOrder = await fetchTransakOrder(order.transak_order_id);
        } else {
          transakOrder = await fetchTransakOrderByPartnerOrderId(order.cashout_id);
        }
      } catch {
        // Transak API may be unavailable; skip this order for now.
      }

      if (transakOrder) {
        const before = order.status;
        const result = await syncCashoutStatusFromTransak(userId, order.cashout_id);
        if (result.status !== before) reconciled++;
      }
      // No `else` — see the doc-comment above. Auto-refund on "no order
      // found" was the source of the Account-1 double-pay exploit and
      // has been removed. Users who legitimately can't continue (popup
      // blocked) cancel via the toast button instead.
    } catch (err) {
      console.error(`[Reconcile] Failed to reconcile cashout ${order.cashout_id}:`, err);
    }
  }

  return reconciled;
}

/**
 * Hard 2-hour timeout sweep across all in-flight orders. Closes anything
 * older than IN_FLIGHT_TIMEOUT_MS regardless of Transak's view, so the
 * UI doesn't accumulate "pending" rows indefinitely when the webhook
 * never reaches us.
 *
 * Trade orders (Buy):  pending_payment → cancelled. No funds have moved
 *                      yet at this status, so no refund needed.
 * Cashouts (Sell):     awaiting_transak → failed + balance refund.
 *                      Crypto isn't sent until status flips to
 *                      crypto_sent, so the user's tokens are still
 *                      escrowed in the platform and we can return them.
 *
 * Statuses past those gates (payment_received, processing, crypto_sent,
 * payout_sent) involve external state (card charged, crypto on-chain)
 * and are NOT auto-cancelled — the existing per-order recovery paths
 * (`recoverStuckExecutingOrder`, `syncCashoutStatusFromTransak`) own
 * those.
 */
export async function expireInFlightOrders(): Promise<{
  tradesCancelled: number;
  cashoutsRefunded: number;
  topUpsCancelled: number;
}> {
  const cutoffSeconds = Math.floor(IN_FLIGHT_TIMEOUT_MS / 1000);

  // 1) Trade orders — no refund needed at pending_payment.
  const [tradeRes] = await adminDb.execute<ResultSetHeader>(
    `UPDATE trade_orders
        SET status = 'cancelled',
            failure_reason = 'Auto-cancelled: timed out after 2 hours'
      WHERE status = 'pending_payment'
        AND created_at < (NOW() - INTERVAL ? SECOND)`,
    [cutoffSeconds]
  );
  const tradesCancelled = tradeRes.affectedRows ?? 0;

  // 1b) Stable top-up on-ramp orders — same as trade pending_payment
  //     (user hasn't paid Transak yet, so no refund is needed). Scoped
  //     to `target_token IS NOT NULL` so we only touch rows from the new
  //     Buy flow; trade-linked onramps (target_token NULL) are owned by
  //     the trade lifecycle and the legacy /onramp orphans (also NULL)
  //     are unreachable from the new dApp.
  //
  //     `onramp_orders` has no 'cancelled' enum value (just pending /
  //     processing / completed / failed / refunded), so we set
  //     status = 'failed' with the 'Auto-cancelled:' prefix that
  //     mapOnRampStatus translates into the grey UI pill. Mirrors how
  //     cashout cancellations are encoded.
  const [topUpRes] = await adminDb.execute<ResultSetHeader>(
    `UPDATE onramp_orders
        SET status = 'failed',
            failure_reason = 'Auto-cancelled: timed out after 2 hours'
      WHERE target_token IS NOT NULL
        AND status IN ('pending', 'processing')
        AND created_at < (NOW() - INTERVAL ? SECOND)`,
    [cutoffSeconds]
  );
  const topUpsCancelled = topUpRes.affectedRows ?? 0;

  // 2) Cashouts in awaiting_transak — refund per existing reconcile
  //    pattern (handles PLAT → USDX post-swap special case via
  //    operator_tx_hash).
  const [staleCashouts] = await adminDb.execute<
    (RowDataPacket & CashoutOrder)[]
  >(
    `SELECT * FROM cashout_orders
       WHERE status = 'awaiting_transak'
         AND created_at < (NOW() - INTERVAL ? SECOND)`,
    [cutoffSeconds]
  );

  let cashoutsRefunded = 0;
  for (const order of staleCashouts) {
    try {
      // Verify with Transak before refunding. The 2-hour cutoff alone
      // isn't safe — Transak can have a `COMPLETED` order that hasn't
      // synced into our DB yet (broken redirect, dropped webhook), and
      // refunding here would double-pay. Only proceed when Transak
      // confirms it's not paying the user.
      const transakCheck = await checkTransakRefundable(order);
      if (
        transakCheck.kind === "committed" ||
        transakCheck.kind === "lookup_failed"
      ) {
        console.log(
          `[Expire] Skipping refund for ${order.cashout_id}: Transak check = ${transakCheck.kind}${
            "status" in transakCheck ? ` (${transakCheck.status})` : ""
          }`
        );
        continue;
      }

      const refundToken =
        order.token === "PLAT" && order.operator_tx_hash
          ? "USDX"
          : order.token;
      const refundAmount =
        order.token === "PLAT" && order.operator_tx_hash
          ? parseFloat(order.tusd_amount).toFixed(18)
          : parseFloat(order.token_amount).toFixed(18);

      // Atomic claim before crediting — see
      // `userRefundAwaitingTransakCashout` for the full rationale.
      // The 2-hour timeout sweep races with any `processWalletRedirection`
      // that just landed; we mustn't credit a refund AND let the sale
      // complete.
      const [claimRes] = await adminDb.execute<ResultSetHeader>(
        `UPDATE cashout_orders SET
          status = 'failed',
          failure_reason = 'Auto-refund: timed out after 2 hours',
          processed_by = 'system-expire',
          processed_at = NOW(),
          process_notes = 'Hard timeout (2h)'
        WHERE cashout_id = ? AND status = 'awaiting_transak'`,
        [order.cashout_id]
      );
      if (claimRes.affectedRows === 0) {
        // Lost the race — sale is going through, no refund owed.
        continue;
      }

      try {
        await creditBalance(
          order.user_id,
          refundToken as CashoutToken,
          refundAmount,
          {
            notes: `Auto-refund: cashout ${order.cashout_id} timed out after 2 hours`,
            type: "adjustment",
            createdBy: "system-expire",
          }
        );
        cashoutsRefunded++;
      } catch (creditErr) {
        try {
          await adminDb.execute(
            `UPDATE cashout_orders SET
              status = 'awaiting_transak',
              failure_reason = NULL,
              processed_by = NULL,
              processed_at = NULL,
              process_notes = NULL
            WHERE cashout_id = ? AND status = 'failed'`,
            [order.cashout_id]
          );
        } catch (revertErr) {
          console.error(
            `[CRITICAL] Expire sweep claim succeeded but both credit and revert failed for cashout ${order.cashout_id}. Owed ${refundAmount} ${refundToken}.`,
            { creditErr, revertErr }
          );
        }
        throw creditErr;
      }
    } catch (err) {
      console.error(
        `[Expire] Failed to refund stale cashout ${order.cashout_id}:`,
        err
      );
    }
  }

  if (tradesCancelled > 0 || cashoutsRefunded > 0 || topUpsCancelled > 0) {
    console.log(
      `[Expire] Auto-closed ${tradesCancelled} trade order(s), refunded ${cashoutsRefunded} cashout(s), cancelled ${topUpsCancelled} stable top-up(s) after 2h timeout.`
    );
  }

  return { tradesCancelled, cashoutsRefunded, topUpsCancelled };
}
