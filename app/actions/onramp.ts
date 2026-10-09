"use server";

// app/actions/onramp.ts
// Server actions for on-ramp operations

import { getServerSession } from "@/app/lib/auth-service";
import {
  createOnRampOrder,
  createOnRampWidgetUrl,
  getUserOnRampOrders,
  getOrderByPartnerOrderId,
  getTransakPriceQuote,
  linkTransakOrder,
  getTreasuryTRNSKBalance,
  verifyTRNSKReceipt,
  fetchTransakOrder,
  fetchTransakOrderByPartnerOrderId,
  pollAndProcessTransakOrder,
  cancelStableTopUpOrder,
  TRANSAK_CONFIG,
  type OnRampTargetToken,
} from "@/app/lib/transak-service";
import { getTransakKYCPrefill } from "@/app/lib/kyc-helper";
import type { FiatCurrency } from "@/app/lib/payment-service";
import { TRANSAK_MIN_PER_CURRENCY, estimateOnRampFee } from "@/app/lib/transak-limits";
import { calculateSwapRate } from "@/app/lib/chainlink-service";
import { fiatToTusd } from "@/app/lib/trade-order-service";

/**
 * Create a new on-ramp order
 */
export async function createOrder(
  fiatCurrency: string = "USD",
  fiatAmount: string = "100",
  cryptoCurrency: string = "USDC"
) {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const result = await createOnRampOrder(
      session.userId,
      fiatCurrency,
      fiatAmount,
      cryptoCurrency
    );

    return {
      success: true,
      orderId: result.orderId,
      partnerOrderId: result.partnerOrderId,
    };
  } catch (error) {
    console.error("[OnRamp Action] Create order failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create order",
    };
  }
}

/**
 * Get user's on-ramp history
 */
export async function getMyOnRampHistory(limit: number = 20) {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Unauthorized", orders: [] };
  }

  try {
    const orders = await getUserOnRampOrders(session.userId, limit);
    return { success: true, orders };
  } catch (error) {
    console.error("[OnRamp Action] Get history failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get history",
      orders: [],
    };
  }
}

/**
 * Get order status
 */
export async function getOrderStatus(partnerOrderId: string) {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const order = await getOrderByPartnerOrderId(partnerOrderId);
    
    if (!order) {
      return { success: false, error: "Order not found" };
    }
    
    // Verify user owns this order
    if (order.user_id !== session.userId) {
      return { success: false, error: "Unauthorized" };
    }

    return {
      success: true,
      order: {
        status: order.status,
        fiatAmount: order.fiat_amount,
        fiatCurrency: order.fiat_currency,
        tusdAmount: order.tusd_amount,
        // Surfaced so the Buy form's polling can tell whether the post-credit
        // ledger swap (USDX → target stable) has settled. For target=USDX
        // or NULL target these are both NULL and the client can treat
        // status === 'completed' as final.
        targetToken: order.target_token,
        targetSwapTransactionId: order.target_swap_transaction_id,
        createdAt: order.created_at,
        completedAt: order.completed_at,
      },
    };
  } catch (error) {
    console.error("[OnRamp Action] Get status failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get status",
    };
  }
}

/**
 * Cancel a still-unpaid standalone stable on-ramp top-up (the Buy form's
 * "stable" flavour). User-facing analogue of `cancelBuyOrderAction` (which
 * owns the trade / PLAT path); both share the same Transak-status guard
 * so a payment that's already processing or delivered can't be cancelled
 * out from under the user.
 */
export async function cancelStableTopUpAction(
  partnerOrderId: string
): Promise<{ success: boolean; error?: string }> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Unauthorized" };

  try {
    const order = await getOrderByPartnerOrderId(partnerOrderId);
    if (!order) return { success: false, error: "Order not found" };
    if (order.user_id !== session.userId) {
      return { success: false, error: "Unauthorized" };
    }
    if (order.status === "completed") {
      return {
        success: false,
        error: "Payment was already received. Please wait for your balance to update.",
      };
    }

    // Guard against cancelling a payment Transak is already processing /
    // has delivered — the card may already be charged. Same status list as
    // cancelBuyOrderAction (TRANSAK_PROCESSING_STATUSES on the client).
    let transakOrderId = order.transak_order_id;
    if (!transakOrderId && order.partner_order_id) {
      const found = await fetchTransakOrderByPartnerOrderId(order.partner_order_id);
      if (found) transakOrderId = found._id;
    }
    if (transakOrderId) {
      try {
        const transakData = await fetchTransakOrder(transakOrderId);
        const nonCancellable = [
          "PROCESSING",
          "PENDING_DELIVERY_FROM_TRANSAK",
          "ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK",
          "COMPLETED",
        ];
        if (nonCancellable.includes(transakData.status)) {
          return {
            success: false,
            error:
              "Your payment is being processed by Transak and can no longer be cancelled. Please wait for it to complete.",
          };
        }
      } catch (err) {
        // Fail safe: if Transak is unreachable, don't cancel — the user can
        // retry once it's back.
        console.error("[cancelStableTopUp] Failed to verify Transak status:", err);
        return {
          success: false,
          error: "Could not verify payment status with Transak. Please try again in a moment.",
        };
      }
    }

    return await cancelStableTopUpOrder(partnerOrderId, session.userId);
  } catch (error) {
    console.error("[OnRamp Action] Cancel top-up failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to cancel order",
    };
  }
}

/**
 * Check TRNSK test-token balance on the treasury wallet (staging only).
 * Returns the balance so you can verify Transak delivered tokens.
 */
export async function checkTreasuryTRNSKBalance() {
  if (TRANSAK_CONFIG.environment === "PRODUCTION") {
    return { success: false, error: "Only available in staging" };
  }

  try {
    const result = await getTreasuryTRNSKBalance();
    return {
      success: true,
      balance: result.formatted,
      wallet: result.wallet,
      token: "TRNSK",
      network: "Base Sepolia",
    };
  } catch (error) {
    console.error("[OnRamp Action] TRNSK balance check failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to check balance",
    };
  }
}

/**
 * Verify a specific Transak tx hash delivered TRNSK to the treasury (staging only).
 */
export async function verifyTransakTxReceipt(txHash: string) {
  if (TRANSAK_CONFIG.environment === "PRODUCTION") {
    return { success: false, error: "Only available in staging" };
  }

  if (!txHash || !txHash.startsWith("0x")) {
    return { success: false, error: "Invalid transaction hash" };
  }

  try {
    const result = await verifyTRNSKReceipt(txHash);
    return {
      success: true,
      verified: result.verified,
      amount: result.amount,
      to: result.to,
      token: "TRNSK",
      network: "Base Sepolia",
    };
  } catch (error) {
    console.error("[OnRamp Action] TRNSK tx verify failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to verify receipt",
    };
  }
}

/**
 * Link Transak order ID to our order (called from widget events)
 */
export async function linkTransakOrderId(
  partnerOrderId: string,
  transakOrderId: string
) {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Verify the order belongs to this user
    const order = await getOrderByPartnerOrderId(partnerOrderId);
    
    if (!order) {
      return { success: false, error: "Order not found" };
    }
    
    if (order.user_id !== session.userId) {
      return { success: false, error: "Unauthorized" };
    }

    await linkTransakOrder(partnerOrderId, transakOrderId);
    return { success: true };
  } catch (error) {
    console.error("[OnRamp Action] Link order failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to link order",
    };
  }
}

/**
 * Fetch a Transak order's current status from their API.
 */
export async function getTransakOrderDetails(transakOrderId: string) {
  try {
    const data = await fetchTransakOrder(transakOrderId);
    return {
      success: true,
      data: {
        orderId: data._id,
        status: data.status,
        fiatCurrency: data.fiatCurrency,
        fiatAmount: data.fiatAmount,
        cryptoCurrency: data.cryptoCurrency,
        cryptoAmount: data.cryptoAmount,
        network: data.network,
        walletAddress: data.walletAddress,
        transactionHash: data.transactionHash,
        completedAt: data.completedAt,
      },
    };
  } catch (error) {
    console.error("[OnRamp Action] Fetch Transak order failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch order",
    };
  }
}

/**
 * Poll a Transak order and process it if completed.
 * This is the fallback for local dev where webhooks can't reach localhost.
 * It re-uses the same credit logic as the webhook handler.
 */
export async function pollTransakOrder(transakOrderId: string) {
  if (!transakOrderId) {
    return { success: false, error: "Missing Transak order ID" };
  }

  try {
    const result = await pollAndProcessTransakOrder(transakOrderId);
    return { success: true, ...result };
  } catch (error) {
    console.error("[OnRamp Action] Poll Transak order failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to poll order",
    };
  }
}

/**
 * Poll a standalone on-ramp order by its internal partner_order_id, without
 * the client having to know the Transak order id (which is only assigned
 * after the user actually starts payment in the widget).
 *
 * Mirrors `pollActivePaymentAction` in `trade-orders.ts`: looks up the order,
 * resolves the Transak order id via Transak's API if our row doesn't have one
 * yet (the localhost case where the webhook can't reach us), and runs the
 * normal credit + post-credit-swap pipeline.
 */
export async function pollOnRampByPartnerOrderId(partnerOrderId: string) {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  if (!partnerOrderId) {
    return { success: false, error: "Missing partner order ID" };
  }

  try {
    const order = await getOrderByPartnerOrderId(partnerOrderId);
    if (!order) return { success: false, error: "Order not found" };
    if (order.user_id !== session.userId) {
      return { success: false, error: "Unauthorized" };
    }

    // Terminal states — no point polling Transak again.
    if (order.status === "completed" || order.status === "failed" || order.status === "refunded") {
      return {
        success: true,
        processed: false,
        message: `Order is ${order.status}`,
        status: order.status,
      };
    }

    // Resolve the Transak order id. On localhost the webhook never fires so
    // transak_order_id is NULL until we ask Transak for it.
    let transakOrderId = order.transak_order_id;
    if (!transakOrderId) {
      const transakOrder = await fetchTransakOrderByPartnerOrderId(partnerOrderId);
      if (!transakOrder) {
        return {
          success: true,
          processed: false,
          message: "Transak hasn't created an order yet — payment may not have started",
          status: order.status,
        };
      }
      transakOrderId = transakOrder._id;
    }

    const result = await pollAndProcessTransakOrder(transakOrderId);
    return { success: true, ...result };
  } catch (error) {
    console.error("[OnRamp Action] Poll by partner-order-id failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to poll order",
    };
  }
}

// ============================================================================
// STABLE TOP-UP (Buy form, non-PLAT destination)
// ============================================================================
// `createStableTopUpAction` is the entry point used by the Exchange Buy tab
// when the user picks USDX / EURX / GBPX / BRLX as the receive token.
// PLAT purchases continue to flow through `createBuyOrderAction` in
// `trade-orders.ts`, which routes through the AMM. This action stops at the
// standalone on-ramp: Transak delivers USDC → operator credits user's USDX
// ledger. For non-USD targets the same webhook handler chains a fee-skipped
// ledger swap from USDX to the chosen PLAT-fiat (see transak-service.ts
// `processTransakWebhook`).

const VALID_TARGET_TOKENS: OnRampTargetToken[] = [
  "USDX",
  "EURX",
  "GBPX",
  "BRLX",
];

const VALID_FIAT_CURRENCIES: FiatCurrency[] = ["USD", "EUR", "GBP", "BRL"];

interface StableTopUpResult {
  partnerOrderId: string;
  widgetUrl: string;
  targetToken: OnRampTargetToken;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
}

type StableTopUpActionResult =
  | { success: true; data: StableTopUpResult }
  | { success: false; error: string };

interface StableTopUpQuote {
  fiatCurrency: FiatCurrency;
  fiatAmount: number;
  /** Fee-excluded fiat value of the tokens (fiatAmount - transakFee). The
   *  "gross" the user effectively converts; shown as "Token cost". */
  grossFiatAmount: number;
  targetToken: OnRampTargetToken;
  /** Transak fee in the payment fiat currency (sum of all fee breakdown items). */
  transakFee: number;
  feePercent: number;
  /** Net USDX the user would receive from Transak (post-Transak-fee). */
  netTusdAmount: number;
  /** Final amount of `targetToken` credited to the user after the optional
   *  USDX → target_token ledger swap. For target=USDX this equals
   *  `netTusdAmount`. */
  receiveAmount: number;
  /** Chainlink rate USDX → targetToken (1 for USDX targets). */
  usdxToTargetRate: number;
  /** Fee-excluded display rate: fiat per 1 target token. Renders
   *  "1 {targetToken} = X {fiat}" at the underlying peg/FX; Transak's fee is
   *  surfaced separately so a USD-paid USDX reads a clean 1.00. */
  fiatPerTarget: number;
}

type StableTopUpQuoteResult =
  | { success: true; data: StableTopUpQuote }
  | { success: false; error: string };

/**
 * Quote a stable-top-up. Mirrors the PLAT buy quote in shape: a single
 * server-side call that hits Transak's pricing API + Chainlink so the client
 * doesn't have to combine them.
 */
export async function getStableTopUpQuote(
  fiatCurrency: string,
  fiatAmount: string,
  targetToken: string
): Promise<StableTopUpQuoteResult> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  const fiat = fiatCurrency?.toUpperCase() as FiatCurrency;
  if (!VALID_FIAT_CURRENCIES.includes(fiat)) {
    return { success: false, error: "Unsupported fiat currency" };
  }

  const target = targetToken as OnRampTargetToken;
  if (!VALID_TARGET_TOKENS.includes(target)) {
    return { success: false, error: "Unsupported target token" };
  }

  const amount = parseFloat(fiatAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Invalid amount" };
  }

  try {
    let totalFee: number;
    let feeDecimal: number;
    let netTusdAmount: number;

    try {
      const tq = await getTransakPriceQuote(fiat, amount);
      totalFee = tq.totalFee;
      feeDecimal = tq.feeDecimal;
      netTusdAmount = tq.cryptoAmount;
    } catch (apiErr) {
      console.warn("[OnRamp Action] Transak quote API unavailable, using fallback schedule:", apiErr);
      const fallback = estimateOnRampFee(amount, fiat);
      totalFee = fallback.totalFee;
      feeDecimal = fallback.feePct / 100;
      const netFiat = Math.max(0, amount - totalFee);
      const { tusdAmount } = await fiatToTusd(netFiat, fiat);
      netTusdAmount = tusdAmount;
    }

    // Chainlink rate USDX → target token. For target = USDX this is 1.
    // For non-USD targets the post-credit ledger swap runs with
    // `skipProcessingFee: true`, so no additional fee is applied beyond
    // Transak's — the receiveAmount is just netTusdAmount × rate.
    let usdxToTargetRate = 1;
    if (target !== "USDX") {
      const rateData = await calculateSwapRate("USDX", target);
      usdxToTargetRate = rateData.rate;
    }
    const receiveAmount = netTusdAmount * usdxToTargetRate;
    // `amount` is fee-INCLUSIVE (the total the user pays Transak), so the
    // fee-excluded base — the gross the user actually converts — is
    // amount - totalFee.
    const grossFiatAmount = amount - totalFee;
    // Fee-excluded peg/FX rate (fiat per 1 target token). Excluding Transak's
    // fee makes USDX-in-USD read 1.00 and cross-currency pairs show the true
    // FX rate; the fee is shown as its own line in the review modal.
    const fiatPerTarget = receiveAmount > 0 ? grossFiatAmount / receiveAmount : 0;

    return {
      success: true,
      data: {
        fiatCurrency: fiat,
        fiatAmount: amount,
        grossFiatAmount,
        targetToken: target,
        transakFee: totalFee,
        feePercent: feeDecimal * 100,
        netTusdAmount,
        receiveAmount,
        usdxToTargetRate,
        fiatPerTarget,
      },
    };
  } catch (error) {
    console.error("[OnRamp Action] Stable top-up quote failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get quote",
    };
  }
}

export async function createStableTopUpAction(
  fiatCurrency: string,
  fiatAmount: string,
  targetToken: string
): Promise<StableTopUpActionResult> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  // Validate fiat currency
  const fiat = fiatCurrency?.toUpperCase() as FiatCurrency;
  if (!VALID_FIAT_CURRENCIES.includes(fiat)) {
    return { success: false, error: "Unsupported fiat currency" };
  }

  // Validate target token
  const target = targetToken as OnRampTargetToken;
  if (!VALID_TARGET_TOKENS.includes(target)) {
    return { success: false, error: "Unsupported target token" };
  }

  // Validate amount
  const amount = parseFloat(fiatAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Invalid amount" };
  }

  // Enforce Transak Lite-KYC minimum (same gate the buy flow applies).
  const minForCurrency = TRANSAK_MIN_PER_CURRENCY[fiat];
  if (amount < minForCurrency) {
    return {
      success: false,
      error: `Minimum payment via Transak is ${minForCurrency} ${fiat}.`,
    };
  }

  if (!TRANSAK_CONFIG.apiKey) {
    return { success: false, error: "On-ramp is not configured." };
  }

  try {
    // Create the on-ramp order, persisting the user's chosen destination.
    // When target === 'USDX', the column stays as 'USDX' but the webhook
    // handler short-circuits the swap leg (same effect as NULL but explicit
    // about the user's intent).
    const order = await createOnRampOrder(
      session.userId,
      fiat,
      fiatAmount,
      "USDC",
      { targetToken: target }
    );

    // Build the widget URL with KYC prefill so the user lands on Transak
    // with their email / personal details pre-filled (matches the legacy
    // standalone onramp page).
    const kycPrefill = await getTransakKYCPrefill(session.userId);
    const widgetUrl = await createOnRampWidgetUrl({
      partnerOrderId: order.partnerOrderId,
      userId: session.userId,
      fiatCurrency: fiat,
      fiatAmount: amount,
      email: kycPrefill?.email ?? session.email,
      userData: kycPrefill?.userData,
    });

    return {
      success: true,
      data: {
        partnerOrderId: order.partnerOrderId,
        widgetUrl,
        targetToken: target,
        fiatAmount: amount,
        fiatCurrency: fiat,
      },
    };
  } catch (error) {
    console.error("[OnRamp Action] Stable top-up failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create order",
    };
  }
}

