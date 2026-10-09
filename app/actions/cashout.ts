// app/actions/cashout.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import { getUserBalance, getAllUserBalances } from "@/app/lib/ledger-service";
import {
  getCashoutQuote as getCashoutQuoteService,
  createCashoutRequest,
  initiateCashoutWithTransak,
  userRefundAwaitingTransakCashout,
  processWalletRedirection,
  getCashoutOrderStatus,
  syncCashoutStatusFromTransak,
  reconcileStaleAwaitingOrders,
  expireInFlightOrders,
  getUserCashouts,
  getAllCashouts,
  getPendingCashouts,
  markCashoutCompleted,
  markCashoutFailed,
  type CashoutToken,
  type CashoutQuote,
  type CashoutOrder,
} from "@/app/lib/cashout-service";
import type { FiatCurrency, BankDetails } from "@/app/lib/payment-service";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================================================
// QUOTES
// ============================================================================

export async function getCashoutQuoteAction(
  token: string,
  amount: string,
  fiatCurrency: string = "USD"
): Promise<ActionResult<CashoutQuote>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!amount || parseFloat(amount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const quote = await getCashoutQuoteService(
      token as CashoutToken,
      amount,
      fiatCurrency as FiatCurrency
    );
    return { success: true, data: quote };
  } catch (error) {
    console.error("Failed to get cashout quote:", error);
    const msg = error instanceof Error ? error.message : "Failed to get quote";
    return { success: false, error: msg };
  }
}

// ============================================================================
// CASHOUT CREATION
// ============================================================================

export async function createCashoutAction(
  token: string,
  amount: string,
  fiatCurrency: string,
  bankDetails: BankDetails
): Promise<ActionResult<{ cashout: CashoutOrder }>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!amount || parseFloat(amount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const balance = await getUserBalance(session.userId, token as CashoutToken);
    if (parseFloat(balance) < parseFloat(amount)) {
      return {
        success: false,
        error: `Insufficient ${token} balance. Have: ${parseFloat(balance).toFixed(4)}, Need: ${parseFloat(amount).toFixed(4)}`,
      };
    }

    const cashout = await createCashoutRequest(
      session.userId,
      token as CashoutToken,
      amount,
      fiatCurrency as FiatCurrency,
      bankDetails
    );

    return { success: true, data: { cashout } };
  } catch (error) {
    console.error("Failed to create cashout:", error);
    const msg = error instanceof Error ? error.message : "Failed to create cashout";

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
// TRANSAK OFF-RAMP
// ============================================================================

export async function initiateCashoutTransakAction(
  token: string,
  amount: string,
  fiatCurrency: string = "USD",
  idempotencyKey?: string
): Promise<
  ActionResult<{ cashoutId: string; widgetUrl: string; order: CashoutOrder }>
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!amount || parseFloat(amount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const result = await initiateCashoutWithTransak(
      session.userId,
      token as CashoutToken,
      amount,
      fiatCurrency as FiatCurrency,
      session.email,
      idempotencyKey?.trim() ? { idempotencyKey: idempotencyKey.trim() } : undefined
    );
    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to initiate Transak cashout:", error);
    const msg = error instanceof Error ? error.message : "Failed to start cashout";
    if (msg.includes("Operator insufficient") || msg.includes("Operator wallet low")) {
      return {
        success: false,
        error: "Liquidity temporarily unavailable. Try a smaller amount or later.",
      };
    }
    return { success: false, error: msg };
  }
}

export async function processWalletRedirectionAction(
  cashoutId: string,
  depositAddress: string,
  transakOrderId: string
): Promise<ActionResult<CashoutOrder>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const order = await processWalletRedirection(
      session.userId,
      cashoutId,
      depositAddress,
      transakOrderId
    );
    return { success: true, data: order };
  } catch (error) {
    console.error("processWalletRedirectionAction:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send crypto",
    };
  }
}

export async function getCashoutStatusAction(
  cashoutId: string
): Promise<
  ActionResult<{
    status: string;
    treasuryTxHash: string | null;
    operatorTxHash: string | null;
    fiatAmount: string;
    failureReason: string | null;
  }>
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const s = await syncCashoutStatusFromTransak(session.userId, cashoutId);
    return { success: true, data: s };
  } catch (error) {
    console.warn("[getCashoutStatusAction] Sync failed, falling back to local:", error);
    try {
      const local = await getCashoutOrderStatus(session.userId, cashoutId);
      return { success: true, data: local };
    } catch (fallbackError) {
      return {
        success: false,
        error: fallbackError instanceof Error ? fallbackError.message : "Failed to get status",
      };
    }
  }
}

/** Cancel an `awaiting_transak` cashout and restore the user's ledger (USDX if PLAT was already swapped). */
export async function cancelAwaitingTransakCashoutAction(
  cashoutId: string
): Promise<ActionResult<void>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    await userRefundAwaitingTransakCashout(session.userId, cashoutId);
    return { success: true, data: undefined };
  } catch (error) {
    console.error("cancelAwaitingTransakCashoutAction:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to cancel cashout",
    };
  }
}

// ============================================================================
// AUTOMATIC RECONCILIATION
// ============================================================================

/**
 * Reconcile all awaiting_transak cashout orders for the current user.
 * Auto-refunds stale orders (no Transak order after 5 min) and syncs
 * active ones via the Transak API. Called on page load.
 */
export async function reconcileAwaitingCashouts(): Promise<ActionResult<{ reconciled: number }>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    // Global 2-hour timeout sweep — runs before the per-user reconcile
    // so any expired orders are cleared regardless of who happens to
    // hit the Exchange page. Cheap (two indexed UPDATEs in the common
    // empty case) and idempotent.
    await expireInFlightOrders().catch((err) => {
      console.error("[reconcileAwaitingCashouts] expire sweep failed:", err);
    });

    const reconciled = await reconcileStaleAwaitingOrders(session.userId);
    return { success: true, data: { reconciled } };
  } catch (error) {
    console.error("reconcileAwaitingCashouts:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to reconcile cashouts",
    };
  }
}

// ============================================================================
// USER QUERIES
// ============================================================================

export async function getMyCashoutHistory(
  limit = 50,
  offset = 0
): Promise<ActionResult<CashoutOrder[]>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const cashouts = await getUserCashouts(session.userId, limit, offset);
    return { success: true, data: cashouts };
  } catch (error) {
    console.error("Failed to get cashout history:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get history",
    };
  }
}

export async function getMyBalances(): Promise<
  ActionResult<{ token_symbol: string; balance: string }[]>
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const balances = await getAllUserBalances(session.userId);
    return { success: true, data: balances };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get balances",
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

export async function getAdminCashouts(
  limit = 50,
  offset = 0
): Promise<ActionResult<CashoutOrder[]>> {
  try {
    await requireAdmin();
    const cashouts = await getAllCashouts(limit, offset);
    return { success: true, data: cashouts };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get cashouts",
    };
  }
}

export async function getAdminPendingCashouts(): Promise<ActionResult<CashoutOrder[]>> {
  try {
    await requireAdmin();
    const cashouts = await getPendingCashouts();
    return { success: true, data: cashouts };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get pending cashouts",
    };
  }
}

export async function adminCompleteCashout(
  cashoutId: string,
  paymentReference: string,
  notes?: string
): Promise<ActionResult<void>> {
  try {
    const session = await requireAdmin();
    await markCashoutCompleted(cashoutId, session.userId, paymentReference, notes);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to complete cashout",
    };
  }
}

export async function adminFailCashout(
  cashoutId: string,
  notes: string
): Promise<ActionResult<void>> {
  try {
    const session = await requireAdmin();
    await markCashoutFailed(cashoutId, session.userId, notes);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to update cashout",
    };
  }
}
