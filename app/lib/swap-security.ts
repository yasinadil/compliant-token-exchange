// app/lib/swap-security.ts
// Security layer for swap operations: rate limiting, daily limits, approvals, KYC

import { db, adminDb } from "./db";
import crypto from "crypto";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

// Fallback defaults (used when DB settings are unavailable)
const DEFAULT_MAX_TRADES_PER_DAY = 20;
const DEFAULT_DAILY_LIMIT_USD = 10000;
const DEFAULT_APPROVAL_THRESHOLD_USD = 5000;
const DEFAULT_PROCESSING_FEE_BPS = 0;
const APPROVAL_EXPIRY_HOURS = 24;

// Burst rate limit (hardcoded, protects against scripted abuse)
const BURST_RATE_LIMIT_SWAPS = 5;
const BURST_RATE_LIMIT_WINDOW_SECONDS = 60;

// In-memory cache for platform settings (refreshed every 60s)
let settingsCache: Record<string, string> | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * Load platform settings from DB (cached 60s)
 */
export async function getPlatformSettings(): Promise<Record<string, string>> {
  if (settingsCache && Date.now() - settingsCacheTime < SETTINGS_CACHE_TTL_MS) {
    return settingsCache;
  }

  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT setting_key, setting_value FROM swap_platform_settings"
    );
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.setting_key] = row.setting_value;
    }
    settingsCache = settings;
    settingsCacheTime = Date.now();
    return settings;
  } catch {
    return {
      max_trades_per_day: String(DEFAULT_MAX_TRADES_PER_DAY),
      daily_volume_limit_usd: String(DEFAULT_DAILY_LIMIT_USD),
      approval_threshold_usd: String(DEFAULT_APPROVAL_THRESHOLD_USD),
      kyc_required: "true",
      kyc_required_trade: "true",
    };
  }
}

/**
 * Force-refresh platform settings cache (called after admin updates)
 */
export function invalidateSettingsCache(): void {
  settingsCache = null;
  settingsCacheTime = 0;
}

async function getMaxTradesPerDay(): Promise<number> {
  const s = await getPlatformSettings();
  return parseInt(s.max_trades_per_day) || DEFAULT_MAX_TRADES_PER_DAY;
}

/** Enforced for every user; admin Fiat Swap Configuration. `user_swap_settings.daily_limit_usd` is not read. */
async function getDailyVolumeLimitUsd(): Promise<number> {
  const s = await getPlatformSettings();
  return parseFloat(s.daily_volume_limit_usd) || DEFAULT_DAILY_LIMIT_USD;
}

async function getApprovalThresholdUsd(): Promise<number> {
  const s = await getPlatformSettings();
  return parseFloat(s.approval_threshold_usd) || DEFAULT_APPROVAL_THRESHOLD_USD;
}

export async function getProcessingFeeBps(): Promise<number> {
  const s = await getPlatformSettings();
  const val = parseInt(s.processing_fee_bps);
  if (isNaN(val) || val < 0) return DEFAULT_PROCESSING_FEE_BPS;
  return Math.min(val, 1000);
}

export async function isKycRequired(): Promise<boolean> {
  const s = await getPlatformSettings();
  return s.kyc_required !== "false";
}

export async function isTradeKycRequired(): Promise<boolean> {
  const s = await getPlatformSettings();
  return s.kyc_required_trade !== "false";
}

interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

interface DailyLimitCheck {
  allowed: boolean;
  usedToday: number;
  remaining: number;
  limit: number;
}

interface SwapSecurityCheck {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  approvalId?: string;
}

interface PendingApproval {
  id: number;
  approval_id: string;
  user_id: string;
  from_token: string;
  from_amount: string;
  to_token: string;
  estimated_to_amount: string;
  usd_value: string;
  status: string;
  created_at: string;
  expires_at: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_notes?: string;
  hold_transaction_id?: string;
}

/**
 * Generate a unique approval ID
 */
function generateApprovalId(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Check if user is paused from swapping
 */
export async function isUserPaused(userId: string): Promise<{
  paused: boolean;
  reason?: string;
}> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT is_swap_paused, pause_reason FROM user_swap_settings WHERE user_id = ?",
    [userId]
  );

  if (rows.length === 0) {
    return { paused: false };
  }

  return {
    paused: rows[0].is_swap_paused === 1,
    reason: rows[0].pause_reason,
  };
}

/**
 * Check burst rate limit (5 swaps per minute - hardcoded anti-abuse)
 */
export async function checkRateLimit(userId: string): Promise<RateLimitCheck> {
  const windowStart = new Date(Date.now() - BURST_RATE_LIMIT_WINDOW_SECONDS * 1000);

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) as count, MIN(swap_timestamp) as oldest 
     FROM swap_rate_limits 
     WHERE user_id = ? AND swap_timestamp > ?`,
    [userId, windowStart]
  );

  const count = rows[0]?.count || 0;
  const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : null;

  let resetInSeconds = BURST_RATE_LIMIT_WINDOW_SECONDS;
  if (oldest) {
    const oldestAge = (Date.now() - oldest.getTime()) / 1000;
    resetInSeconds = Math.max(0, BURST_RATE_LIMIT_WINDOW_SECONDS - oldestAge);
  }

  return {
    allowed: count < BURST_RATE_LIMIT_SWAPS,
    remaining: Math.max(0, BURST_RATE_LIMIT_SWAPS - count),
    resetInSeconds: Math.ceil(resetInSeconds),
  };
}

interface DailyTradeCountCheck {
  allowed: boolean;
  tradesUsed: number;
  maxTrades: number;
}

/**
 * Check daily trade count limit (configurable via admin panel)
 */
export async function checkDailyTradeCount(userId: string): Promise<DailyTradeCountCheck> {
  const today = new Date().toISOString().split("T")[0];
  const maxTrades = await getMaxTradesPerDay();

  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT swap_count FROM daily_swap_totals WHERE user_id = ? AND swap_date = ?",
    [userId, today]
  );

  const tradesUsed = rows.length > 0 ? parseInt(rows[0].swap_count) || 0 : 0;

  return {
    allowed: tradesUsed < maxTrades,
    tradesUsed,
    maxTrades,
  };
}

/**
 * Record a swap for rate limiting
 */
export async function recordSwapForRateLimit(userId: string): Promise<void> {
  await db.execute(
    "INSERT INTO swap_rate_limits (user_id) VALUES (?)",
    [userId]
  );

  // Cleanup old entries (older than 5 minutes)
  await db.execute(
    "DELETE FROM swap_rate_limits WHERE swap_timestamp < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
  );
}

/**
 * Check daily swap volume limit (platform-wide: `swap_platform_settings.daily_volume_limit_usd`).
 */
export async function checkDailyLimit(
  userId: string,
  additionalUsdValue: number = 0
): Promise<DailyLimitCheck> {
  const today = new Date().toISOString().split("T")[0];
  const limit = await getDailyVolumeLimitUsd();

  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT total_usd_value FROM daily_swap_totals WHERE user_id = ? AND swap_date = ?",
    [userId, today]
  );

  const usedToday = rows.length > 0 ? parseFloat(rows[0].total_usd_value) : 0;
  const remaining = Math.max(0, limit - usedToday);

  return {
    allowed: usedToday + additionalUsdValue <= limit,
    usedToday,
    remaining,
    limit,
  };
}

/**
 * Update daily swap total
 */
export async function updateDailyTotal(
  userId: string,
  usdValue: number
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  await db.execute(
    `INSERT INTO daily_swap_totals (user_id, swap_date, total_usd_value, swap_count)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE 
       total_usd_value = total_usd_value + VALUES(total_usd_value),
       swap_count = swap_count + 1`,
    [userId, today, usdValue]
  );
}

/**
 * Check if swap requires admin approval (configurable threshold)
 */
export async function requiresApproval(usdValue: number): Promise<boolean> {
  const threshold = await getApprovalThresholdUsd();
  return usdValue >= threshold;
}

/**
 * Create pending approval for large transaction
 */
export async function createPendingApproval(
  userId: string,
  fromToken: string,
  fromAmount: number,
  toToken: string,
  estimatedToAmount: number,
  fromUsdRate: number,
  toUsdRate: number,
  usdValue: number,
  options?: {
    ipAddress?: string;
    userAgent?: string;
    holdTransactionId?: string;
  }
): Promise<string> {
  const approvalId = generateApprovalId();
  const expiresAt = new Date(Date.now() + APPROVAL_EXPIRY_HOURS * 60 * 60 * 1000);

  await db.execute(
    `INSERT INTO pending_swap_approvals (
      approval_id, user_id, from_token, from_amount, to_token, estimated_to_amount,
      usd_value, from_usd_rate, to_usd_rate, expires_at, ip_address, user_agent, hold_transaction_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      approvalId,
      userId,
      fromToken,
      fromAmount.toFixed(18),
      toToken,
      estimatedToAmount.toFixed(18),
      usdValue.toFixed(2),
      fromUsdRate.toFixed(18),
      toUsdRate.toFixed(18),
      expiresAt,
      options?.ipAddress ?? null,
      options?.userAgent ?? null,
      options?.holdTransactionId ?? null,
    ]
  );

  return approvalId;
}

/**
 * Get pending approval by ID
 */
export async function getPendingApproval(
  approvalId: string
): Promise<PendingApproval | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT * FROM pending_swap_approvals WHERE approval_id = ?",
    [approvalId]
  );

  return rows.length > 0 ? (rows[0] as PendingApproval) : null;
}

/**
 * Get all pending approvals (for admin)
 * Uses adminDb - requires elevated privileges
 */
export async function getAllPendingApprovals(): Promise<PendingApproval[]> {
  const [rows] = await adminDb.query<RowDataPacket[]>(
    `SELECT * FROM pending_swap_approvals 
     WHERE status = 'pending' AND expires_at > NOW()
     ORDER BY created_at DESC`
  );

  return rows as PendingApproval[];
}

/**
 * Get user's pending approvals
 */
export async function getUserPendingApprovals(
  userId: string
): Promise<PendingApproval[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM pending_swap_approvals 
     WHERE user_id = ? AND status = 'pending' AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [userId]
  );

  return rows as PendingApproval[];
}

/**
 * Approve a pending swap
 * Uses adminDb - requires elevated privileges
 */
export async function approveSwap(
  approvalId: string,
  adminUserId: string,
  notes?: string
): Promise<boolean> {
  const [result] = await adminDb.execute<ResultSetHeader>(
    `UPDATE pending_swap_approvals 
     SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
     WHERE approval_id = ? AND status = 'pending' AND expires_at > NOW()`,
    [adminUserId, notes ?? null, approvalId]
  );

  return result.affectedRows > 0;
}

/**
 * Reject a pending swap
 * Uses adminDb - requires elevated privileges
 */
export async function rejectSwap(
  approvalId: string,
  adminUserId: string,
  notes?: string
): Promise<boolean> {
  const [result] = await adminDb.execute<ResultSetHeader>(
    `UPDATE pending_swap_approvals 
     SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
     WHERE approval_id = ? AND status = 'pending'`,
    [adminUserId, notes ?? null, approvalId]
  );

  return result.affectedRows > 0;
}

/**
 * Mark approval as executed
 */
export async function markApprovalExecuted(
  approvalId: string,
  swapId: number
): Promise<void> {
  await db.execute(
    `UPDATE pending_swap_approvals 
     SET status = 'executed', executed_swap_id = ?
     WHERE approval_id = ?`,
    [swapId, approvalId]
  );
}

/**
 * Pause user from swapping
 * Uses adminDb - requires elevated privileges
 */
export async function pauseUser(
  userId: string,
  adminUserId: string,
  reason: string
): Promise<void> {
  await adminDb.execute(
    `INSERT INTO user_swap_settings (user_id, is_swap_paused, pause_reason, paused_by, paused_at, daily_limit_usd)
     VALUES (?, TRUE, ?, ?, NOW(), NULL)
     ON DUPLICATE KEY UPDATE 
       is_swap_paused = TRUE, 
       pause_reason = VALUES(pause_reason),
       paused_by = VALUES(paused_by),
       paused_at = NOW()`,
    [userId, reason, adminUserId]
  );
}

/**
 * Unpause user
 * Uses adminDb - requires elevated privileges
 */
export async function unpauseUser(userId: string): Promise<void> {
  await adminDb.execute(
    `UPDATE user_swap_settings 
     SET is_swap_paused = FALSE, pause_reason = NULL, paused_by = NULL, paused_at = NULL
     WHERE user_id = ?`,
    [userId]
  );
}

/**
 * Check if user has admin role (from session roles array)
 * Roles come from the auth API: the identity provider/api/Auth
 */
export function isAdminRole(roles: string[] | undefined): boolean {
  if (!roles || !Array.isArray(roles)) return false;
  return roles.some(role => 
    role.toLowerCase() === "admin" || 
    role.toLowerCase() === "superadmin" ||
    role.toLowerCase() === "super_admin"
  );
}

/**
 * Log admin action
 * Uses adminDb - requires elevated privileges
 */
export async function logAdminAction(
  adminUserId: string,
  actionType: string,
  targetUserId?: string,
  targetApprovalId?: string,
  details?: Record<string, any>,
  ipAddress?: string
): Promise<void> {
  await adminDb.execute(
    `INSERT INTO admin_audit_log (admin_user_id, action_type, target_user_id, target_approval_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      adminUserId,
      actionType,
      targetUserId ?? null,
      targetApprovalId ?? null,
      details ? JSON.stringify(details) : null,
      ipAddress ?? null,
    ]
  );
}

/**
 * Get all paused users (for admin)
 * Uses adminDb - requires elevated privileges
 */
export async function getPausedUsers(): Promise<any[]> {
  const [rows] = await adminDb.query<RowDataPacket[]>(
    `SELECT user_id, pause_reason, paused_by, paused_at 
     FROM user_swap_settings 
     WHERE is_swap_paused = TRUE
     ORDER BY paused_at DESC`
  );

  return rows;
}

/**
 * Expire stale pending approvals and release their held funds.
 * Call this periodically (e.g. on page load, or via cron).
 */
export async function expireStaleApprovals(): Promise<number> {
  const { releaseHold } = await import("./ledger-service");

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT approval_id, user_id, from_token, from_amount, hold_transaction_id
     FROM pending_swap_approvals
     WHERE status = 'pending' AND expires_at <= NOW()`
  );

  let expiredCount = 0;

  for (const row of rows) {
    try {
      await db.execute(
        `UPDATE pending_swap_approvals SET status = 'expired' WHERE approval_id = ? AND status = 'pending'`,
        [row.approval_id]
      );

      if (row.hold_transaction_id) {
        await releaseHold(
          row.user_id,
          row.from_token,
          row.from_amount,
          `Hold released: approval ${row.approval_id} expired`
        );
      }

      expiredCount++;
    } catch (error) {
      console.error(`Failed to expire approval ${row.approval_id}:`, error);
    }
  }

  return expiredCount;
}

/**
 * Full security check before swap
 */
export async function performSecurityCheck(
  userId: string,
  usdValue: number
): Promise<SwapSecurityCheck> {
  // Check if user is paused
  const pauseStatus = await isUserPaused(userId);
  if (pauseStatus.paused) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Account paused: ${pauseStatus.reason || "Contact support"}`,
    };
  }

  // Check burst rate limit (anti-abuse: 5/min)
  const rateLimit = await checkRateLimit(userId);
  if (!rateLimit.allowed) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Rate limit exceeded. Try again in ${rateLimit.resetInSeconds} seconds.`,
    };
  }

  // Check daily trade count (configurable via admin panel)
  const tradeCount = await checkDailyTradeCount(userId);
  if (!tradeCount.allowed) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Daily trade limit reached (${tradeCount.tradesUsed}/${tradeCount.maxTrades} trades). Try again tomorrow.`,
    };
  }

  // Check daily volume limit (configurable via admin panel)
  const dailyLimit = await checkDailyLimit(userId, usdValue);
  if (!dailyLimit.allowed) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Daily volume limit exceeded. Used: $${dailyLimit.usedToday.toFixed(2)} / $${dailyLimit.limit.toFixed(2)}`,
    };
  }

  // Approval check — fires on either:
  //   • a single swap ≥ threshold (the original rule)
  //   • OR a swap that pushes the user's cumulative daily volume to ≥
  //     threshold (closes the chunking exploit: previously a user could
  //     do 2× $4,999 swaps and skip admin review entirely).
  // `dailyLimit.usedToday` is reused from the volume-limit check above
  // so we don't hit the DB twice.
  const threshold = await getApprovalThresholdUsd();
  const cumulativeAfter = dailyLimit.usedToday + usdValue;
  if (usdValue >= threshold) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: `Transactions above $${threshold.toLocaleString()} require admin approval.`,
    };
  }
  if (cumulativeAfter >= threshold) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: `This swap would push your daily volume to $${cumulativeAfter.toFixed(2)}, which crosses the $${threshold.toLocaleString()} admin-approval threshold.`,
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
  };
}

/**
 * Get security thresholds (for display in UI)
 */
export async function getSecurityThresholds() {
  const settings = await getPlatformSettings();
  const feeBps = parseInt(settings.processing_fee_bps);
  return {
    maxTradesPerDay: parseInt(settings.max_trades_per_day) || DEFAULT_MAX_TRADES_PER_DAY,
    dailyLimitUsd: parseFloat(settings.daily_volume_limit_usd) || DEFAULT_DAILY_LIMIT_USD,
    approvalThresholdUsd: parseFloat(settings.approval_threshold_usd) || DEFAULT_APPROVAL_THRESHOLD_USD,
    kycRequired: settings.kyc_required !== "false",
    burstRateLimitSwaps: BURST_RATE_LIMIT_SWAPS,
    burstRateLimitWindowSeconds: BURST_RATE_LIMIT_WINDOW_SECONDS,
    processingFeeBps: isNaN(feeBps) || feeBps < 0 ? DEFAULT_PROCESSING_FEE_BPS : Math.min(feeBps, 1000),
  };
}

/**
 * Update a platform setting (admin only)
 */
export async function updatePlatformSetting(
  key: string,
  value: string,
  adminUserId: string
): Promise<void> {
  const allowedKeys = [
    "max_trades_per_day",
    "daily_volume_limit_usd",
    "approval_threshold_usd",
    "kyc_required",
    "kyc_required_trade",
    "processing_fee_bps",
  ];

  if (!allowedKeys.includes(key)) {
    throw new Error(`Invalid setting key: ${key}`);
  }

  await adminDb.execute(
    `UPDATE swap_platform_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?`,
    [value, adminUserId, key]
  );

  invalidateSettingsCache();
}

