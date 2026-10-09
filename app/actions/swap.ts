// app/actions/swap.ts
"use server";
import { UPSTREAM_API_BASE } from "@/app/lib/upstream";

import { getServerSession, getAccessToken } from "@/app/lib/auth-service";
import {
  getAllUserBalances,
  getSwapQuote,
  executeSwap,
  holdFunds,
  getSwapHistory,
  type FiatToken,
  type SwapQuote,
  type SwapResult,
  type UserBalance,
} from "@/app/lib/ledger-service";
import { getAllRates, calculateSwapRate } from "@/app/lib/chainlink-service";
import {
  getConvertQuote as getConvertQuoteService,
  createConvertOrder,
  type ConvertQuote,
  type ConvertToken,
  type ProcessResult,
} from "@/app/lib/trade-order-service";
import {
  performSecurityCheck,
  checkRateLimit,
  checkDailyLimit,
  checkDailyTradeCount,
  recordSwapForRateLimit,
  updateDailyTotal,
  createPendingApproval,
  getUserPendingApprovals,
  getSecurityThresholds,
  isKycRequired,
  expireStaleApprovals,
} from "@/app/lib/swap-security";
import { headers } from "next/headers";

const KYC_API_BASE = UPSTREAM_API_BASE;

export type SwapQuoteResult =
  | { success: true; quote: SwapQuote }
  | { success: false; error: string };

export type SwapExecuteResult =
  | { success: true; result: SwapResult }
  | { success: false; error: string; requiresApproval?: boolean; approvalId?: string };

export type BalancesResult =
  | { success: true; balances: UserBalance[] }
  | { success: false; error: string };

export type RatesResult =
  | { success: true; rates: Record<string, number> }
  | { success: false; error: string };

export type SwapHistoryResult =
  | { success: true; transactions: any[] }
  | { success: false; error: string };

export type SecurityInfoResult =
  | { success: true; rateLimit: any; dailyLimit: any; dailyTradeCount: any; thresholds: any; pendingApprovals: any[] }
  | { success: false; error: string };

export type KYCStatusResult =
  | { success: true; kycApproved: boolean; kycRequired: boolean }
  | { success: false; error: string };

/**
 * Get all T Fiat balances for the current user
 */
export async function getMyBalances(): Promise<BalancesResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const balances = await getAllUserBalances(session.userId);
    return { success: true, balances };
  } catch (error) {
    console.error("Failed to get balances:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get balances",
    };
  }
}

/**
 * Get current exchange rates from Chainlink
 */
export async function getCurrentRates(): Promise<RatesResult> {
  try {
    const ratesData = await getAllRates();
    const rates: Record<string, number> = {};
    
    for (const [token, data] of Object.entries(ratesData)) {
      rates[token] = data.rate;
    }
    
    return { success: true, rates };
  } catch (error) {
    console.error("Failed to get rates:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get rates",
    };
  }
}

/**
 * Check KYC status for the current user via the platform /CheckKYCStatus endpoint.
 * Returns whether the user has an approved KYC session.
 */
export async function checkKycStatus(): Promise<KYCStatusResult> {
  const session = await getServerSession();
  if (!session) {
    console.error("[Swap KYC] No session found");
    return { success: false, error: "Not authenticated" };
  }

  const kycRequired = await isKycRequired();
  if (!kycRequired) {
    return { success: true, kycApproved: true, kycRequired: false };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("[Swap KYC] No access token in cookies");
    return { success: true, kycApproved: false, kycRequired: true };
  }

  try {
    const params = new URLSearchParams({ token: accessToken });
    console.log("[Swap KYC] Calling CheckKYCStatus for userId:", session.userId);

    const res = await fetch(`${KYC_API_BASE}/Financial/CheckKYCStatus?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[Swap KYC] API error:", res.status, res.statusText);
      return { success: true, kycApproved: false, kycRequired: true };
    }

    const body = await res.json();
    const approved = body.Status === "OK" && body.Result?.Status === "Approved";
    console.log("[Swap KYC] Result:", body.Result?.Status, "approved:", approved);

    return { success: true, kycApproved: approved, kycRequired: true };
  } catch (error) {
    console.error("[Swap KYC] Failed:", error);
    return { success: true, kycApproved: false, kycRequired: true };
  }
}

/**
 * Get a swap quote without executing
 */
export async function getQuote(
  fromToken: string,
  toToken: string,
  fromAmount: string
): Promise<SwapQuoteResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!fromToken || !toToken || !fromAmount) {
    return { success: false, error: "Missing required parameters" };
  }

  try {
    const quote = await getSwapQuote(fromToken, toToken, fromAmount);
    return { success: true, quote };
  } catch (error) {
    console.error("Failed to get quote:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get quote",
    };
  }
}

/**
 * Execute a swap between T Fiat tokens
 */
export async function executeSwapAction(
  fromToken: string,
  toToken: string,
  fromAmount: string
): Promise<SwapExecuteResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!fromToken || !toToken || !fromAmount) {
    return { success: false, error: "Missing required parameters" };
  }

  const amount = parseFloat(fromAmount);
  if (isNaN(amount) || amount <= 0) {
    return { success: false, error: "Invalid amount" };
  }

  // KYC gate
  const kycStatus = await checkKycStatus();
  if (kycStatus.success && kycStatus.kycRequired && !kycStatus.kycApproved) {
    return { success: false, error: "KYC verification required. Please complete identity verification before swapping." };
  }

  try {
    // Get request metadata for audit
    const headersList = await headers();
    const ipAddress = headersList.get("x-forwarded-for") || headersList.get("x-real-ip") || "unknown";
    const userAgent = headersList.get("user-agent") || "unknown";

    // Calculate USD value for security check
    const rateData = await calculateSwapRate(fromToken, toToken);
    const usdValue = amount * rateData.fromUSDRate;

    // Perform security checks
    const securityCheck = await performSecurityCheck(session.userId, usdValue);

    if (!securityCheck.allowed) {
      if (securityCheck.requiresApproval) {
        // Hold funds first so the user can't double-spend
        const hold = await holdFunds(
          session.userId,
          fromToken,
          amount.toString(),
          `Hold for pending swap approval: ${fromToken} -> ${toToken}`
        );

        // Create pending approval linked to the hold
        const approvalId = await createPendingApproval(
          session.userId,
          fromToken,
          amount,
          toToken,
          amount * rateData.rate,
          rateData.fromUSDRate,
          rateData.toUSDRate,
          usdValue,
          { ipAddress, userAgent, holdTransactionId: hold.transactionId }
        );

        return {
          success: false,
          error: securityCheck.reason || "Requires admin approval",
          requiresApproval: true,
          approvalId,
        };
      }

      return { success: false, error: securityCheck.reason || "Security check failed" };
    }

    // Execute the swap
    const result = await executeSwap(session.userId, fromToken, toToken, fromAmount, {
      ipAddress,
      userAgent,
    });

    // Record for rate limiting
    await recordSwapForRateLimit(session.userId);

    // Update daily total
    await updateDailyTotal(session.userId, usdValue);

    return { success: true, result };
  } catch (error) {
    console.error("Swap failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Swap failed",
    };
  }
}

/**
 * Get swap transaction history for the current user
 */
export async function getMySwapHistory(
  limit: number = 50,
  offset: number = 0
): Promise<SwapHistoryResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const transactions = await getSwapHistory(session.userId, limit, offset);
    return { success: true, transactions };
  } catch (error) {
    console.error("Failed to get swap history:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get history",
    };
  }
}

// ============================================================================
// CONVERT (PLAT ↔ stablecoin, internal-only)
// ============================================================================
// Convert tab actions for conversions that involve PLAT on either side.
// stable ↔ stable Convert keeps flowing through the existing
// getQuote / executeSwapAction above (pure Chainlink ledger swap). When
// PLAT is involved, we route through the trade-order-service convert
// path, which composes operator-mediated AMM + (for non-USD pairs) the
// fee-skipped ledger leg.

const VALID_CONVERT_TOKENS: ConvertToken[] = [
  "USDX",
  "EURX",
  "GBPX",
  "BRLX",
  "PLAT",
];

function isConvertToken(t: string): t is ConvertToken {
  return (VALID_CONVERT_TOKENS as readonly string[]).includes(t);
}

export type ConvertQuoteResult =
  | { success: true; quote: ConvertQuote }
  | { success: false; error: string };

export type ConvertExecuteResult =
  | { success: true; result: ProcessResult }
  | { success: false; error: string; requiresApproval?: boolean; approvalId?: string };

/**
 * Quote a Convert that involves PLAT on either side. For stable ↔
 * stable, callers should keep using `getQuote` (ledger-only).
 */
export async function getConvertQuoteAction(
  fromToken: string,
  toToken: string,
  fromAmount: string
): Promise<ConvertQuoteResult> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  if (!isConvertToken(fromToken) || !isConvertToken(toToken)) {
    return { success: false, error: "Unsupported token" };
  }
  if (fromToken === toToken) {
    return { success: false, error: "Pick two different tokens" };
  }
  if (fromToken !== "PLAT" && toToken !== "PLAT") {
    return {
      success: false,
      error: "Use the stable-swap quote for stable↔stable conversions",
    };
  }

  try {
    const quote = await getConvertQuoteService(fromToken, toToken, fromAmount);
    return { success: true, quote };
  } catch (error) {
    console.error("Failed to get convert quote:", error);
    const msg = error instanceof Error ? error.message : "Failed to get quote";
    if (msg.includes("InvalidPhase")) {
      return { success: false, error: "Pool is not active. Trading is currently disabled." };
    }
    return { success: false, error: msg };
  }
}

/**
 * Execute a Convert that involves PLAT on either side.
 *
 * Preserves the existing swap-side guardrails:
 *   • KYC gate (mirrors executeSwapAction).
 *   • Security check ($5k auto / $10k hard cap, admin approval funnel).
 *   • Rate-limit + daily-total tracking (so the daily $10k cap actually
 *     binds across Convert / Buy / Sell — a PLAT Convert participates
 *     in the same budget as a stable-stable Convert).
 *
 * Stable ↔ stable conversions should keep going through executeSwapAction
 * (this action will reject them with a clear error).
 */
export async function executeConvertAction(
  fromToken: string,
  toToken: string,
  fromAmount: string
): Promise<ConvertExecuteResult> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  if (!isConvertToken(fromToken) || !isConvertToken(toToken)) {
    return { success: false, error: "Unsupported token" };
  }
  if (fromToken === toToken) {
    return { success: false, error: "Pick two different tokens" };
  }
  if (fromToken !== "PLAT" && toToken !== "PLAT") {
    return {
      success: false,
      error:
        "Use the standard swap action for stable↔stable conversions (no AMM leg involved).",
    };
  }

  const amount = parseFloat(fromAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Invalid amount" };
  }

  // KYC gate — same trigger as executeSwapAction. Both Buy/Sell and Convert
  // share this policy so users see consistent behaviour across the dApp.
  const kycStatus = await checkKycStatus();
  if (kycStatus.success && kycStatus.kycRequired && !kycStatus.kycApproved) {
    return {
      success: false,
      error: "KYC verification required. Please complete identity verification before converting.",
    };
  }

  try {
    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") || headersList.get("x-real-ip") || "unknown";
    const userAgent = headersList.get("user-agent") || "unknown";

    // Compute USD value via the source token's Chainlink rate so the
    // security check counts the convert toward the user's daily budget.
    // `getConvertQuoteService` returns `fromUSDValue` already; cheaper to
    // re-quote than to look it up twice.
    let quote: ConvertQuote;
    try {
      quote = await getConvertQuoteService(
        fromToken as ConvertToken,
        toToken as ConvertToken,
        fromAmount
      );
    } catch (quoteErr) {
      const msg = quoteErr instanceof Error ? quoteErr.message : "Quote failed";
      if (msg.includes("InvalidPhase")) {
        return { success: false, error: "Pool is not active. Trading is currently disabled." };
      }
      return { success: false, error: msg };
    }
    const usdValue = quote.fromUSDValue;

    // Security check — same one stable↔stable Convert already runs.
    const securityCheck = await performSecurityCheck(session.userId, usdValue);
    if (!securityCheck.allowed) {
      if (securityCheck.requiresApproval) {
        // Hold funds in the source token so the user can't double-spend
        // while the convert is in approval queue. Mirrors executeSwapAction.
        const hold = await holdFunds(
          session.userId,
          fromToken,
          amount.toString(),
          `Hold for pending convert approval: ${fromToken} -> ${toToken}`
        );
        const approvalId = await createPendingApproval(
          session.userId,
          fromToken,
          amount,
          toToken,
          parseFloat(quote.toAmount),
          usdValue / amount, // fromUSDRate
          // toUSDRate — approximated from the quote's rate so the approval
          // queue can display matching numbers when an admin reviews.
          usdValue / Math.max(parseFloat(quote.toAmount), 1e-18),
          usdValue,
          { ipAddress, userAgent, holdTransactionId: hold.transactionId }
        );
        return {
          success: false,
          error: securityCheck.reason || "Requires admin approval",
          requiresApproval: true,
          approvalId,
        };
      }
      return { success: false, error: securityCheck.reason || "Security check failed" };
    }

    // Execute the convert via the trade-order-service path. Generates its
    // own idempotency key — the UI also passes one through eventually,
    // but the action-level guard keeps double-submits coalescing even
    // when the caller doesn't supply one.
    const idempotencyKey =
      typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
        ? globalThis.crypto.randomUUID()
        : `convert-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const result = await createConvertOrder(
      session.userId,
      fromToken as ConvertToken,
      toToken as ConvertToken,
      fromAmount,
      { ipAddress, userAgent, idempotencyKey }
    );

    if (!result.success) {
      return { success: false, error: result.error || "Convert failed" };
    }

    // Record for rate limiting + daily total (same accounting as
    // executeSwapAction so the budget is shared across Convert variants).
    await recordSwapForRateLimit(session.userId).catch(() => {});
    await updateDailyTotal(session.userId, usdValue).catch(() => {});

    return { success: true, result };
  } catch (error) {
    console.error("Convert failed:", error);
    const msg = error instanceof Error ? error.message : "Convert failed";
    if (msg.includes("InvalidPhase")) {
      return { success: false, error: "Pool is not active. Trading is currently disabled." };
    }
    return { success: false, error: msg };
  }
}

/**
 * Get security info for current user (rate limits, daily limits, pending approvals)
 */
export async function getMySecurityInfo(): Promise<SecurityInfoResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    // Release holds for any expired approvals before fetching fresh data
    await expireStaleApprovals().catch(() => {});

    const [rateLimit, dailyLimit, dailyTradeCount, pendingApprovals, thresholds] = await Promise.all([
      checkRateLimit(session.userId),
      checkDailyLimit(session.userId),
      checkDailyTradeCount(session.userId),
      getUserPendingApprovals(session.userId),
      getSecurityThresholds(),
    ]);

    return {
      success: true,
      rateLimit,
      dailyLimit,
      dailyTradeCount,
      thresholds,
      pendingApprovals,
    };
  } catch (error) {
    console.error("Failed to get security info:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get security info",
    };
  }
}
