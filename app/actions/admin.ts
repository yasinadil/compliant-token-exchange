// app/actions/admin.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import {
  isAdminRole,
  getAllPendingApprovals,
  getPausedUsers,
  approveSwap,
  rejectSwap,
  pauseUser,
  unpauseUser,
  logAdminAction,
  getPendingApproval,
  getPlatformSettings,
  updatePlatformSetting,
} from "@/app/lib/swap-security";
import { executeSwapFromHold, releaseHold } from "@/app/lib/ledger-service";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type CheckoutApiKey,
} from "@/app/lib/checkout-service";
import {
  getPlatformWallet,
  createPlatformWallet,
  rotatePlatformWallet,
  redactPrivateKey,
  PlatformWalletAlreadyExistsError,
  PlatformWalletNotConfiguredError,
  type PlatformWalletPublicInfo,
  type PlatformWalletStatus,
} from "@/app/lib/platform-wallet-service";
import { headers } from "next/headers";

type AdminResult<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/**
 * Check if current user is admin (based on roles from auth API)
 */
export async function checkIsAdmin(): Promise<AdminResult<boolean>> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  const admin = isAdminRole(session.roles);
  return { success: true, data: admin };
}

/**
 * Get all pending swap approvals (admin only)
 */
export async function getAdminPendingApprovals(): Promise<AdminResult<any[]>> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const approvals = await getAllPendingApprovals();
    return { success: true, data: approvals };
  } catch (error) {
    console.error("Failed to get pending approvals:", error);
    return { success: false, error: "Failed to get pending approvals" };
  }
}

/**
 * Get all paused users (admin only)
 */
export async function getAdminPausedUsers(): Promise<AdminResult<any[]>> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const users = await getPausedUsers();
    return { success: true, data: users };
  } catch (error) {
    console.error("Failed to get paused users:", error);
    return { success: false, error: "Failed to get paused users" };
  }
}

/**
 * Approve a pending swap (admin only)
 */
export async function adminApproveSwap(
  approvalId: string,
  notes?: string
): Promise<AdminResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    // Get the pending approval
    const approval = await getPendingApproval(approvalId);
    if (!approval) {
      return { success: false, error: "Approval not found" };
    }

    if (approval.status !== "pending") {
      return { success: false, error: `Approval already ${approval.status}` };
    }

    // Mark as approved
    const approved = await approveSwap(approvalId, session.userId, notes);
    if (!approved) {
      return { success: false, error: "Failed to approve or approval expired" };
    }

    const headersList = await headers();
    const ipAddress = headersList.get("x-forwarded-for") || headersList.get("x-real-ip") || "unknown";

    try {
      // Execute swap from held funds (not from available balance)
      const swapResult = await executeSwapFromHold(
        approval.user_id,
        approval.from_token,
        approval.to_token,
        approval.from_amount,
        {
          ipAddress,
          notes: `Admin approved by ${session.userId}`,
        }
      );

      await logAdminAction(
        session.userId,
        "approve_swap",
        approval.user_id,
        approvalId,
        { notes, swapResult },
        ipAddress
      );

      return { success: true };
    } catch (swapError) {
      // Swap from hold failed - release the hold and mark as rejected
      try {
        await releaseHold(
          approval.user_id,
          approval.from_token,
          approval.from_amount,
          `Hold released: swap execution failed for approval ${approvalId}`
        );
      } catch (releaseError) {
        console.error("Failed to release hold after swap failure:", releaseError);
      }
      await rejectSwap(approvalId, session.userId, `Swap execution failed: ${swapError}`);
      return { success: false, error: `Swap execution failed: ${swapError}` };
    }
  } catch (error) {
    console.error("Failed to approve swap:", error);
    return { success: false, error: "Failed to approve swap" };
  }
}

/**
 * Reject a pending swap (admin only)
 */
export async function adminRejectSwap(
  approvalId: string,
  notes?: string
): Promise<AdminResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const headersList = await headers();
    const ipAddress = headersList.get("x-forwarded-for") || headersList.get("x-real-ip") || "unknown";

    const approval = await getPendingApproval(approvalId);
    if (!approval) {
      return { success: false, error: "Approval not found" };
    }

    const rejected = await rejectSwap(approvalId, session.userId, notes);
    if (!rejected) {
      return { success: false, error: "Failed to reject approval" };
    }

    // Release held funds back to user's available balance
    if (approval.hold_transaction_id) {
      try {
        await releaseHold(
          approval.user_id,
          approval.from_token,
          approval.from_amount,
          `Hold released: approval ${approvalId} rejected by admin`
        );
      } catch (releaseError) {
        console.error("Failed to release hold on rejection:", releaseError);
      }
    }

    await logAdminAction(
      session.userId,
      "reject_swap",
      approval.user_id,
      approvalId,
      { notes },
      ipAddress
    );

    return { success: true };
  } catch (error) {
    console.error("Failed to reject swap:", error);
    return { success: false, error: "Failed to reject swap" };
  }
}

/**
 * Pause a user from swapping (admin only)
 */
export async function adminPauseUser(
  targetUserId: string,
  reason: string
): Promise<AdminResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!targetUserId || !reason) {
    return { success: false, error: "User ID and reason are required" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const headersList = await headers();
    const ipAddress = headersList.get("x-forwarded-for") || headersList.get("x-real-ip") || "unknown";

    await pauseUser(targetUserId, session.userId, reason);

    await logAdminAction(
      session.userId,
      "pause_user",
      targetUserId,
      undefined,
      { reason },
      ipAddress
    );

    return { success: true };
  } catch (error) {
    console.error("Failed to pause user:", error);
    return { success: false, error: "Failed to pause user" };
  }
}

/**
 * Unpause a user (admin only)
 */
export async function adminUnpauseUser(targetUserId: string): Promise<AdminResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!targetUserId) {
    return { success: false, error: "User ID is required" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const headersList = await headers();
    const ipAddress = headersList.get("x-forwarded-for") || headersList.get("x-real-ip") || "unknown";

    await unpauseUser(targetUserId);

    await logAdminAction(
      session.userId,
      "unpause_user",
      targetUserId,
      undefined,
      {},
      ipAddress
    );

    return { success: true };
  } catch (error) {
    console.error("Failed to unpause user:", error);
    return { success: false, error: "Failed to unpause user" };
  }
}

// ============================================================================
// CHECKOUT API KEY MANAGEMENT
// ============================================================================

export async function createCheckoutApiKeyAction(
  name: string
): Promise<AdminResult<{ keyId: string; secret: string }>> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!name?.trim()) {
    return { success: false, error: "Key name is required" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const result = await createApiKey(name.trim(), session.userId);

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";

    await logAdminAction(
      session.userId,
      "create_checkout_api_key",
      undefined,
      result.keyId,
      { name: name.trim() },
      ipAddress
    );

    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to create checkout API key:", error);
    return { success: false, error: "Failed to create API key" };
  }
}

export async function listCheckoutApiKeysAction(): Promise<AdminResult<CheckoutApiKey[]>> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const keys = await listApiKeys();
    return { success: true, data: keys };
  } catch (error) {
    console.error("Failed to list checkout API keys:", error);
    return { success: false, error: "Failed to list API keys" };
  }
}

export async function revokeCheckoutApiKeyAction(
  keyId: string
): Promise<AdminResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!keyId) {
    return { success: false, error: "Key ID is required" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const revoked = await revokeApiKey(keyId);
    if (!revoked) {
      return { success: false, error: "Key not found or already revoked" };
    }

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";

    await logAdminAction(
      session.userId,
      "revoke_checkout_api_key",
      undefined,
      keyId,
      {},
      ipAddress
    );

    return { success: true };
  } catch (error) {
    console.error("Failed to revoke checkout API key:", error);
    return { success: false, error: "Failed to revoke API key" };
  }
}

// ============================================================================
// COLLECTED FEES
// ============================================================================

export interface FeeStats {
  today: string;
  thisWeek: string;
  thisMonth: string;
  allTime: string;
  recentEntries: {
    order_id: string;
    user_id: string;
    order_type: string;
    fee_bps: number;
    gross_usdx: string;
    fee_usdx: string;
    net_usdx: string;
    created_at: string;
  }[];
}

export async function getCollectedFeeStats(): Promise<AdminResult<FeeStats>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    const { adminDb } = await import("@/app/lib/db");

    const [[todayRows], [weekRows], [monthRows], [allTimeRows], [recentRows]] = await Promise.all([
      adminDb.query(
        `SELECT IFNULL(SUM(fee_usdx), 0) AS total FROM collected_fees WHERE DATE(created_at) = CURDATE()`
      ),
      adminDb.query(
        `SELECT IFNULL(SUM(fee_usdx), 0) AS total FROM collected_fees WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`
      ),
      adminDb.query(
        `SELECT IFNULL(SUM(fee_usdx), 0) AS total FROM collected_fees WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`
      ),
      adminDb.query(
        `SELECT IFNULL(SUM(fee_usdx), 0) AS total FROM collected_fees`
      ),
      adminDb.query(
        `SELECT order_id, user_id, order_type, fee_bps, gross_usdx, fee_usdx, net_usdx, created_at
         FROM collected_fees ORDER BY created_at DESC LIMIT 20`
      ),
    ]);

    const toTotal = (rows: any) => parseFloat((rows as any[])[0]?.total || "0").toFixed(6);

    return {
      success: true,
      data: {
        today: toTotal(todayRows),
        thisWeek: toTotal(weekRows),
        thisMonth: toTotal(monthRows),
        allTime: toTotal(allTimeRows),
        recentEntries: (recentRows as any[]).map((r) => ({
          order_id: r.order_id,
          user_id: r.user_id,
          order_type: r.order_type,
          fee_bps: r.fee_bps,
          gross_usdx: parseFloat(r.gross_usdx).toFixed(6),
          fee_usdx: parseFloat(r.fee_usdx).toFixed(6),
          net_usdx: parseFloat(r.net_usdx).toFixed(6),
          created_at: r.created_at,
        })),
      },
    };
  } catch (error) {
    console.error("Failed to get fee stats:", error);
    return { success: false, error: "Failed to get collected fee statistics" };
  }
}

// ============================================================================
// SWAP PLATFORM SETTINGS
// ============================================================================

export type SwapSettings = Record<string, string>;

/**
 * Get all swap platform settings (admin only)
 */
export async function getSwapPlatformSettings(): Promise<AdminResult<SwapSettings>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }
    const settings = await getPlatformSettings();
    return { success: true, data: settings };
  } catch (error) {
    console.error("Failed to get swap settings:", error);
    return { success: false, error: "Failed to get swap settings" };
  }
}

/**
 * Update a single swap platform setting (admin only)
 */
export async function updateSwapPlatformSetting(
  key: string,
  value: string
): Promise<AdminResult> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  if (!key || value === undefined || value === null) {
    return { success: false, error: "Key and value are required" };
  }

  try {
    if (!isAdminRole(session.roles)) {
      return { success: false, error: "Unauthorized: Admin access required" };
    }

    // Validate numeric settings
    if (key === "max_trades_per_day") {
      const num = parseInt(value);
      if (isNaN(num) || num < 1 || num > 1000) {
        return { success: false, error: "Max trades must be between 1 and 1000" };
      }
    }
    if (key === "daily_volume_limit_usd") {
      const num = parseFloat(value);
      if (isNaN(num) || num < 100) {
        return { success: false, error: "Daily volume limit must be at least $100" };
      }
    }
    if (key === "approval_threshold_usd") {
      const num = parseFloat(value);
      if (isNaN(num) || num < 100) {
        return { success: false, error: "Approval threshold must be at least $100" };
      }
    }
    if (key === "kyc_required" || key === "kyc_required_trade") {
      if (value !== "true" && value !== "false") {
        return { success: false, error: "KYC required must be true or false" };
      }
    }
    if (key === "processing_fee_bps") {
      const num = parseInt(value);
      if (isNaN(num) || num < 0 || num > 1000) {
        return { success: false, error: "Processing fee must be between 0 and 1000 basis points (0-10%)" };
      }
    }

    await updatePlatformSetting(key, value, session.userId);

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";

    await logAdminAction(
      session.userId,
      "update_swap_setting",
      undefined,
      undefined,
      { key, value },
      ipAddress
    );

    return { success: true };
  } catch (error) {
    console.error("Failed to update swap setting:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to update setting",
    };
  }
}

// ============================================================================
// PLATFORM OPERATOR WALLET (admin-managed, DB-backed)
// ============================================================================
// All three actions below:
//   1. require admin via isAdminRole (uniform "Not authorized" on failure so
//      non-admins can't infer whether a wallet exists)
//   2. never return the private key or encrypted blob (type system enforces
//      this because PlatformWalletPublicInfo does not include those fields)
//   3. audit-log generate/rotate, including only the new SA address
//
// Private-key access from `platform-wallet-service` happens ONLY inside
// operator / staking / treasury services, never in this file.

// In-process rate limit per admin for generate/rotate: 1 per 5 min.
// Process-local is acceptable — these are admin-only, human-initiated actions.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const platformWalletRateLimit = new Map<string, number>();

function checkWalletMutationRateLimit(adminUserId: string): string | null {
  const now = Date.now();
  const last = platformWalletRateLimit.get(adminUserId);
  if (last && now - last < RATE_LIMIT_WINDOW_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - last)) / 1000);
    return `Rate limited. Try again in ${waitSec}s.`;
  }
  platformWalletRateLimit.set(adminUserId, now);
  return null;
}

/**
 * Fetch operator wallet status (public metadata only). Non-admins get the
 * same uniform "Not authorized" error regardless of whether a wallet exists.
 */
export async function getPlatformOperatorWalletAction(): Promise<
  AdminResult<PlatformWalletStatus>
> {
  const session = await getServerSession();
  if (!session || !isAdminRole(session.roles)) {
    return { success: false, error: "Not authorized" };
  }

  try {
    const info = await getPlatformWallet("operator");
    return { success: true, data: info };
  } catch (error) {
    console.error(
      "[admin] getPlatformOperatorWalletAction failed:",
      redactPrivateKey(error instanceof Error ? error.message : String(error))
    );
    return { success: false, error: "Failed to fetch operator wallet status" };
  }
}

/**
 * Generate a brand-new operator wallet. Fails if one already exists —
 * rotation is a distinct action so it produces its own audit log entry.
 */
export async function generatePlatformOperatorWalletAction(): Promise<
  AdminResult<PlatformWalletPublicInfo>
> {
  const session = await getServerSession();
  if (!session || !isAdminRole(session.roles)) {
    return { success: false, error: "Not authorized" };
  }

  const rateErr = checkWalletMutationRateLimit(session.userId);
  if (rateErr) return { success: false, error: rateErr };

  try {
    const info = await createPlatformWallet("operator", session.userId);

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";

    await logAdminAction(
      session.userId,
      "generate_platform_wallet",
      undefined,
      undefined,
      {
        role: "operator",
        new_smart_account_address: info.smartAccountAddress,
      },
      ipAddress
    );

    return { success: true, data: info };
  } catch (error) {
    if (error instanceof PlatformWalletAlreadyExistsError) {
      return {
        success: false,
        error: "Operator wallet already exists. Use rotate instead.",
      };
    }
    console.error(
      "[admin] generatePlatformOperatorWalletAction failed:",
      redactPrivateKey(error instanceof Error ? error.message : String(error))
    );
    return { success: false, error: "Failed to generate operator wallet" };
  }
}

/**
 * Rotate the existing operator wallet to a freshly generated one. The old
 * on-chain smart account retains its funds until the admin sweeps them.
 */
export async function rotatePlatformOperatorWalletAction(
  confirmation: string
): Promise<AdminResult<PlatformWalletPublicInfo>> {
  const session = await getServerSession();
  if (!session || !isAdminRole(session.roles)) {
    return { success: false, error: "Not authorized" };
  }

  if (confirmation !== "OPERATOR") {
    return {
      success: false,
      error: "Confirmation phrase did not match",
    };
  }

  const rateErr = checkWalletMutationRateLimit(session.userId);
  if (rateErr) return { success: false, error: rateErr };

  try {
    const info = await rotatePlatformWallet("operator", session.userId);

    const headersList = await headers();
    const ipAddress =
      headersList.get("x-forwarded-for") ||
      headersList.get("x-real-ip") ||
      "unknown";

    await logAdminAction(
      session.userId,
      "rotate_platform_wallet",
      undefined,
      undefined,
      {
        role: "operator",
        new_smart_account_address: info.smartAccountAddress,
      },
      ipAddress
    );

    return { success: true, data: info };
  } catch (error) {
    if (error instanceof PlatformWalletNotConfiguredError) {
      return {
        success: false,
        error:
          "Operator wallet not yet configured. Use generate before rotate.",
      };
    }
    console.error(
      "[admin] rotatePlatformOperatorWalletAction failed:",
      redactPrivateKey(error instanceof Error ? error.message : String(error))
    );
    return { success: false, error: "Failed to rotate operator wallet" };
  }
}
