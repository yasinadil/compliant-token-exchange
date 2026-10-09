// app/actions/trade-orders.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import { getUserBalance, getAllUserBalances, type UserBalance } from "@/app/lib/ledger-service";
import {
  getBuyQuote as getBuyQuoteService,
  getSellQuote as getSellQuoteService,
  createBuyOrder,
  createSellOrder,
  confirmPayment,
  processOrder,
  getOrderHistory,
  listTradeOrdersForAdmin,
  linkOnRampToTradeOrder,
  getOrderStatus as getOrderStatusService,
  getOrderByOrderId,
  cancelPendingOrder,
  type BuyQuote,
  type SellQuote,
  type TradeOrder,
  type ProcessResult,
  type AdminTradeOrderListParams,
} from "@/app/lib/trade-order-service";
import {
  createTradeOnRampOrder,
  createTradeWidgetUrl,
  getOnRampOrderById,
  fetchTransakOrder,
  fetchTransakOrderByPartnerOrderId,
  linkTransakOrder,
  pollAndProcessTransakOrder,
  TRANSAK_CONFIG,
} from "@/app/lib/transak-service";
import {
  getOperatorBalances,
  getOperatorSmartAccountAddress,
  type OperatorBalances,
} from "@/app/lib/operator-service";
import type { FiatCurrency } from "@/app/lib/payment-service";
import { getTransakKYCPrefill } from "@/app/lib/kyc-helper";
import { headers } from "next/headers";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================================================
// QUOTES
// ============================================================================

export async function getBuyQuote(
  fiatCurrency: string,
  fiatAmount: string,
  options?: { skipBalance?: boolean }
): Promise<ActionResult<BuyQuote>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!fiatAmount || parseFloat(fiatAmount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const quote = await getBuyQuoteService(
      fiatCurrency as FiatCurrency,
      fiatAmount,
      session.userId,
      { skipBalance: options?.skipBalance }
    );
    return { success: true, data: quote };
  } catch (error) {
    console.error("Failed to get buy quote:", error);
    const msg = error instanceof Error ? error.message : "Failed to get quote";
    if (msg.includes("InvalidPhase")) {
      return { success: false, error: "Pool is not active. Trading is currently disabled." };
    }
    return { success: false, error: msg };
  }
}

const VALID_PAYOUT_CURRENCIES: FiatCurrency[] = ["USD", "GBP", "EUR", "BRL"];

function normalizePayoutCurrency(value: unknown): FiatCurrency {
  if (typeof value === "string") {
    const upper = value.toUpperCase() as FiatCurrency;
    if (VALID_PAYOUT_CURRENCIES.includes(upper)) return upper;
  }
  return "USD";
}

export async function getSellQuote(
  tglobalAmount: string,
  payoutCurrency?: string
): Promise<ActionResult<SellQuote>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!tglobalAmount || parseFloat(tglobalAmount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const quote = await getSellQuoteService(
      tglobalAmount,
      normalizePayoutCurrency(payoutCurrency)
    );
    return { success: true, data: quote };
  } catch (error) {
    console.error("Failed to get sell quote:", error);
    const msg = error instanceof Error ? error.message : "Failed to get quote";
    if (msg.includes("InvalidPhase")) {
      return { success: false, error: "Pool is not active. Trading is currently disabled." };
    }
    return { success: false, error: msg };
  }
}

// ============================================================================
// ORDER CREATION
// ============================================================================

type BuyOrderResult =
  | { order: TradeOrder; result: ProcessResult; pendingPayment?: never; widgetUrl?: never; fiatAmount?: never; fiatCurrency?: never }
  | { order: TradeOrder; pendingPayment: true; widgetUrl: string; fiatAmount: number; fiatCurrency: string; result?: never };

export async function createBuyOrderAction(
  fiatCurrency: string,
  fiatAmount: string,
  idempotencyKey?: string,
  options?: { skipBalance?: boolean }
): Promise<ActionResult<BuyOrderResult>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!fiatAmount || parseFloat(fiatAmount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";
    const userAgent = headersList.get("user-agent") || "unknown";

    // Accept caller-supplied key, fall back to a request-scoped header so that
    // UI double-submits still coalesce to one order.
    const effectiveKey =
      idempotencyKey?.trim() ||
      headersList.get("x-idempotency-key")?.trim() ||
      undefined;

    const order = await createBuyOrder(
      session.userId,
      fiatCurrency as FiatCurrency,
      fiatAmount,
      {
        ipAddress,
        userAgent,
        idempotencyKey: effectiveKey,
        skipBalance: options?.skipBalance,
      }
    );

    // Fully covered by balance — process immediately
    if (order.status === "payment_received") {
      const result = await processOrder(order.order_id);
      return { success: true, data: { order, result } };
    }

    // Deficit exists — create a linked onramp order for Transak payment
    const chargeAmount = parseFloat(order.charged_fiat_amount);
    const [onramp, kycPrefill] = await Promise.all([
      createTradeOnRampOrder(
        session.userId,
        fiatCurrency,
        chargeAmount.toFixed(2),
        order.order_id
      ),
      getTransakKYCPrefill(session.userId),
    ]);

    await linkOnRampToTradeOrder(order.order_id, onramp.orderId);

    // Generate session-based widget URL server-side (Transak API requirement)
    const widgetUrl = await createTradeWidgetUrl({
      partnerOrderId: onramp.partnerOrderId,
      partnerCustomerId: session.userId,
      fiatCurrency,
      fiatAmount: chargeAmount,
      email: kycPrefill?.email ?? session.email,
      userData: kycPrefill?.userData,
    });

    return {
      success: true,
      data: {
        order,
        pendingPayment: true,
        widgetUrl,
        fiatAmount: chargeAmount,
        fiatCurrency,
      },
    };
  } catch (error) {
    console.error("Failed to create buy order:", error);
    const msg = error instanceof Error ? error.message : "Failed to create order";

    if (msg.includes("NotCompliant")) {
      return { success: false, error: "Your account is not KYC verified." };
    }
    if (msg.includes("InvalidPhase")) {
      return { success: false, error: "Pool is not active. Trading is currently disabled." };
    }
    if (msg.includes("InsufficientLiquidity")) {
      return { success: false, error: "Insufficient liquidity for this trade size." };
    }
    if (msg.includes("Operator insufficient")) {
      return { success: false, error: "Operator balance too low. Please try a smaller amount or try again later." };
    }
    if (msg.includes("TransakMinLimit")) {
      // Pass through verbatim — the service builds the message with
      // the per-currency minimum, e.g. "25 BRL" or "5 USD".
      return {
        success: false,
        error: msg.replace(/^TransakMinLimit:\s*/, ""),
      };
    }

    return { success: false, error: msg };
  }
}

export async function createSellOrderAction(
  tglobalAmount: string,
  payoutCurrency?: string
): Promise<ActionResult<{ order: TradeOrder; result: ProcessResult }>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!tglobalAmount || parseFloat(tglobalAmount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const balance = await getUserBalance(session.userId, "PLAT");
    if (parseFloat(balance) < parseFloat(tglobalAmount)) {
      return {
        success: false,
        error: `Insufficient PLAT balance. Have: ${parseFloat(balance).toFixed(4)}, Need: ${parseFloat(tglobalAmount).toFixed(4)}`,
      };
    }

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";
    const userAgent = headersList.get("user-agent") || "unknown";

    const order = await createSellOrder(
      session.userId,
      tglobalAmount,
      normalizePayoutCurrency(payoutCurrency),
      { ipAddress, userAgent }
    );

    return { success: true, data: { order, result: { success: true, orderId: order.order_id, status: order.status } } };
  } catch (error) {
    console.error("Failed to create sell order:", error);
    const msg = error instanceof Error ? error.message : "Failed to create order";

    if (msg.includes("Insufficient") && msg.includes("balance")) {
      return { success: false, error: msg };
    }
    if (msg.includes("Operator insufficient")) {
      return { success: false, error: "Operator balance too low. Please try a smaller amount or try again later." };
    }

    return { success: false, error: msg };
  }
}

// ============================================================================
// PAYMENT CONFIRMATION (for mock/testing)
// ============================================================================

export async function confirmPaymentAction(
  orderId: string,
  paymentReference: string
): Promise<ActionResult<ProcessResult>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const result = await confirmPayment(orderId, paymentReference);
    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to confirm payment:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to confirm payment",
    };
  }
}

// ============================================================================
// ORDER STATUS POLLING
// ============================================================================

export async function getTradeOrderStatus(
  orderId: string
): Promise<
  ActionResult<{
    status: string;
    tglobalAmount: string;
    tusdAmount: string;
    txHash: string | null;
    failureReason: string | null;
    ammQuotePrice: string | null;
  }>
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const result = await getOrderStatusService(orderId, session.userId);
    if (!result) return { success: false, error: "Order not found" };
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get status",
    };
  }
}

/**
 * Retry a buy order that ended in price_changed or insufficient_balance.
 * Creates a brand-new balance-only buy order for the same fiat amount.
 */
export async function retryBuyOrderAction(
  originalOrderId: string
): Promise<ActionResult<{ order: TradeOrder; result: ProcessResult }>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const { getOrderByOrderId } = await import("@/app/lib/trade-order-service");
    const original = await getOrderByOrderId(originalOrderId);

    if (original.user_id !== session.userId) {
      return { success: false, error: "Not authorized" };
    }

    if (original.status !== "price_changed" && original.status !== "insufficient_balance") {
      return { success: false, error: `Order is not retryable (status: ${original.status})` };
    }

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";
    const userAgent = headersList.get("user-agent") || "unknown";

    // After a Transak-funded order fails, the net USDX (e.g. $18.2 from a $20
    // payment after fees) was refunded to the user's balance. Retry with the
    // user's actual USDX balance so we don't try to charge Transak again for
    // a tiny remainder that would fall below the $20 minimum.
    const tusdBalance = await getUserBalance(session.userId, "USDX");
    const retryAmount = Math.min(
      parseFloat(tusdBalance),
      parseFloat(original.tusd_amount)
    );

    if (retryAmount <= 0) {
      return { success: false, error: "No USDX balance available for retry." };
    }

    const order = await createBuyOrder(
      session.userId,
      "USD" as FiatCurrency,
      retryAmount.toFixed(2),
      { ipAddress, userAgent }
    );

    if (order.status === "payment_received") {
      const result = await processOrder(order.order_id);
      return { success: true, data: { order, result } };
    }

    // If balance still doesn't cover it (shouldn't happen normally)
    return {
      success: false,
      error: "Insufficient balance for retry. Please top up first.",
    };
  } catch (error) {
    console.error("Failed to retry buy order:", error);
    const msg = error instanceof Error ? error.message : "Failed to retry order";
    return { success: false, error: msg };
  }
}

// ============================================================================
// HISTORY & BALANCES
// ============================================================================

export async function getMyTradeHistory(
  limit: number = 50,
  offset: number = 0
): Promise<ActionResult<TradeOrder[]>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const orders = await getOrderHistory(session.userId, limit, offset);
    return { success: true, data: orders };
  } catch (error) {
    console.error("Failed to get trade history:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get history",
    };
  }
}

export async function getMyTGlobalBalance(): Promise<ActionResult<string>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const balance = await getUserBalance(session.userId, "PLAT");
    return { success: true, data: balance };
  } catch (error) {
    console.error("Failed to get PLAT balance:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get balance",
    };
  }
}

export async function getMyTradeBalances(): Promise<ActionResult<UserBalance[]>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const balances = await getAllUserBalances(session.userId);
    return { success: true, data: balances };
  } catch (error) {
    console.error("Failed to get trade balances:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get balances",
    };
  }
}

// ============================================================================
// ORDER MANAGEMENT (cancel / check payment)
// ============================================================================

export async function cancelBuyOrderAction(
  orderId: string
): Promise<ActionResult<void>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    // Guard: if a Transak payment is in flight (PROCESSING /
    // PENDING_DELIVERY_FROM_TRANSAK / COMPLETED), the user can no longer
    // safely cancel — the card may already be charged. Force them to wait
    // for processing to resolve.
    const tradeOrder = await getOrderByOrderId(orderId);
    if (String(tradeOrder.user_id) !== String(session.userId)) {
      return { success: false, error: "Not authorized" };
    }

    if (tradeOrder.onramp_order_id) {
      const onrampOrder = await getOnRampOrderById(tradeOrder.onramp_order_id);
      if (onrampOrder && onrampOrder.status !== "completed") {
        let transakOrderId = onrampOrder.transak_order_id;
        if (!transakOrderId && onrampOrder.partner_order_id) {
          const found = await fetchTransakOrderByPartnerOrderId(
            onrampOrder.partner_order_id
          );
          if (found) transakOrderId = found._id;
        }

        if (transakOrderId) {
          try {
            const transakData = await fetchTransakOrder(transakOrderId);
            // Transak statuses where the user's payment is mid-processing or
            // already completed and they can no longer safely cancel the
            // order. Mirrored on the client as TRANSAK_PROCESSING_STATUSES.
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
            // If we can't reach Transak, fail safe and don't cancel — the user
            // can retry once Transak is reachable again.
            console.error(
              "[cancelBuyOrder] Failed to verify Transak status:",
              err
            );
            return {
              success: false,
              error:
                "Could not verify payment status with Transak. Please try again in a moment.",
            };
          }
        }
      } else if (onrampOrder?.status === "completed") {
        return {
          success: false,
          error:
            "Payment was already received. Please wait for your trade to execute.",
        };
      }
    }

    const result = await cancelPendingOrder(orderId, session.userId);
    if (!result.success) return { success: false, error: result.error || "Cancel failed" };
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to cancel order",
    };
  }
}

/**
 * Background-poll action: if the trade order is still pending_payment and has
 * a linked Transak onramp, poll Transak's API and process if COMPLETED.
 *
 * This replaces the webhook on localhost where Transak can't reach us.
 * Safe to call repeatedly — idempotent via:
 *   - processTransakWebhook: skips if onramp already completed
 *   - confirmPayment: FOR UPDATE lock prevents race with cancel
 *
 * Also returns the current Transak status so the client can advance its UI
 * (e.g. show "Processing" step, hide Cancel button) before our DB transitions
 * to payment_received.
 */
export async function pollActivePaymentAction(
  orderId: string
): Promise<
  ActionResult<{
    processed: boolean;
    message: string;
    transakStatus: string | null;
  }>
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const tradeOrder = await getOrderByOrderId(orderId);
    if (String(tradeOrder.user_id) !== String(session.userId)) {
      return { success: false, error: "Not authorized" };
    }

    if (tradeOrder.status !== "pending_payment") {
      return {
        success: true,
        data: {
          processed: false,
          message: `Order is ${tradeOrder.status}`,
          transakStatus: null,
        },
      };
    }

    if (!tradeOrder.onramp_order_id) {
      return {
        success: true,
        data: {
          processed: false,
          message: "No linked Transak payment",
          transakStatus: null,
        },
      };
    }

    const onrampOrder = await getOnRampOrderById(tradeOrder.onramp_order_id);
    if (!onrampOrder) {
      return {
        success: true,
        data: {
          processed: false,
          message: "On-ramp order not found",
          transakStatus: null,
        },
      };
    }

    if (onrampOrder.status === "completed") {
      return {
        success: true,
        data: {
          processed: false,
          message: "On-ramp already completed",
          transakStatus: "COMPLETED",
        },
      };
    }

    let transakOrderId = onrampOrder.transak_order_id;

    // On localhost the webhook never fires, so transak_order_id is NULL.
    // Fall back to looking up the Transak order by our partner_order_id.
    if (!transakOrderId && onrampOrder.partner_order_id) {
      const transakOrder = await fetchTransakOrderByPartnerOrderId(
        onrampOrder.partner_order_id
      );
      if (!transakOrder) {
        return {
          success: true,
          data: {
            processed: false,
            message: "Transak hasn't created an order yet — payment may not have started",
            transakStatus: null,
          },
        };
      }

      // Link the discovered transak_order_id for future polls
      transakOrderId = transakOrder._id;
      await linkTransakOrder(onrampOrder.partner_order_id, transakOrderId);
      console.log(
        `[pollActivePayment] Linked transak_order_id ${transakOrderId} via partnerOrderId ${onrampOrder.partner_order_id}`
      );
    }

    if (!transakOrderId) {
      return {
        success: true,
        data: {
          processed: false,
          message: "No Transak order ID and no partner order ID to look up",
          transakStatus: null,
        },
      };
    }

    const result = await pollAndProcessTransakOrder(transakOrderId);

    return {
      success: true,
      data: {
        processed: result.credited,
        message: result.message,
        transakStatus: result.status,
      },
    };
  } catch (error) {
    console.error("[pollActivePayment] Error:", error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to poll payment",
    };
  }
}

/**
 * READ-ONLY check for a pending_payment trade order's Transak payment status.
 *
 * This function NEVER writes to the DB, credits balances, or triggers
 * order processing. It only queries Transak's API and our DB to report
 * the current state so the user can decide whether to cancel.
 *
 * Processing (credit + AMM swap) only happens through the webhook or
 * admin-initiated polling — never from a user-facing button.
 */
export async function checkPendingPaymentAction(
  orderId: string
): Promise<
  ActionResult<{
    transakStatus: string;
    onrampStatus: string | null;
    onrampCredited: boolean;
    message: string;
  }>
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const tradeOrder = await getOrderByOrderId(orderId);
    if (String(tradeOrder.user_id) !== String(session.userId)) {
      return { success: false, error: "Not authorized" };
    }

    if (tradeOrder.status !== "pending_payment") {
      return {
        success: true,
        data: {
          transakStatus: "N/A",
          onrampStatus: null,
          onrampCredited: false,
          message: `Order is already ${tradeOrder.status} — no action needed.`,
        },
      };
    }

    if (!tradeOrder.onramp_order_id) {
      return {
        success: true,
        data: {
          transakStatus: "N/A",
          onrampStatus: null,
          onrampCredited: false,
          message:
            "No linked Transak payment. This is a balance-only order — safe to cancel.",
        },
      };
    }

    const onrampOrder = await getOnRampOrderById(tradeOrder.onramp_order_id);
    if (!onrampOrder) {
      return {
        success: true,
        data: {
          transakStatus: "N/A",
          onrampStatus: null,
          onrampCredited: false,
          message:
            "Linked payment record not found. Safe to cancel this order.",
        },
      };
    }

    if (onrampOrder.status === "completed") {
      return {
        success: true,
        data: {
          transakStatus: "COMPLETED",
          onrampStatus: "completed",
          onrampCredited: true,
          message:
            "Payment was completed and USDX was already credited to your balance. " +
            "You can safely cancel this trade order — your USDX is in your balance.",
        },
      };
    }

    // Resolve the Transak order ID — either from our DB or by looking up
    // via partner_order_id (needed on localhost where webhooks don't fire).
    let resolvedTransakId = onrampOrder.transak_order_id;
    if (!resolvedTransakId && onrampOrder.partner_order_id) {
      const found = await fetchTransakOrderByPartnerOrderId(
        onrampOrder.partner_order_id
      );
      if (found) resolvedTransakId = found._id;
    }

    if (!resolvedTransakId) {
      return {
        success: true,
        data: {
          transakStatus: "AWAITING_PAYMENT_FROM_USER",
          onrampStatus: onrampOrder.status,
          onrampCredited: false,
          message:
            "Transak hasn't assigned an order yet — payment likely never started. Safe to cancel.",
        },
      };
    }

    // ── Pure read-only query to Transak API — no side effects ──
    const transakData = await fetchTransakOrder(resolvedTransakId);

    const statusMessages: Record<string, string> = {
      COMPLETED:
        "Transak shows payment completed but our system hasn't processed it yet. " +
        "It will be processed automatically. If it doesn't resolve in a few minutes, contact support.",
      EXPIRED:
        "Transak payment expired — no funds were taken. Safe to cancel.",
      FAILED:
        "Transak payment failed — no funds were taken. Safe to cancel.",
      CANCELLED:
        "Transak payment was cancelled. Safe to cancel this order.",
      AWAITING_PAYMENT_FROM_USER:
        "Transak is still waiting for your payment. If you didn't complete payment, safe to cancel.",
      PENDING_DELIVERY_FROM_TRANSAK:
        "Payment received by Transak, crypto delivery pending. This will process automatically — please wait.",
      PROCESSING:
        "Payment is being processed by Transak. Please wait for it to complete.",
    };

    const message =
      statusMessages[transakData.status] ||
      `Transak status: ${transakData.status}. If payment was made, it will process automatically.`;

    return {
      success: true,
      data: {
        transakStatus: transakData.status,
        onrampStatus: onrampOrder.status,
        onrampCredited: false,
        message,
      },
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to check payment",
    };
  }
}

// ============================================================================
// ADMIN ACTIONS
// ============================================================================

async function requireAdmin() {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  if (!session.roles?.includes("Admin")) throw new Error("Not authorized");
  return session;
}

export async function getAdminTradeOrders(
  params: AdminTradeOrderListParams = {}
): Promise<ActionResult<{ orders: TradeOrder[]; total: number }>> {
  try {
    await requireAdmin();
    const { orders, total } = await listTradeOrdersForAdmin(params);
    return { success: true, data: { orders, total } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get orders",
    };
  }
}

export async function getAdminOperatorInfo(): Promise<
  ActionResult<{ address: string; balances: OperatorBalances }>
> {
  try {
    await requireAdmin();
    const [address, balances] = await Promise.all([
      getOperatorSmartAccountAddress(),
      getOperatorBalances(),
    ]);
    return { success: true, data: { address, balances } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get operator info",
    };
  }
}
