// app/lib/staking-order-service.ts
// Staking order lifecycle management for operator-delegated staking

import crypto from "crypto";
import { db } from "./db";
import { creditBalance, debitBalance, getUserBalance } from "./ledger-service";
import {
  executeOperatorStake,
  executeOperatorUnstake,
  executeOperatorClaim,
  executeOperatorEmergencyWithdraw,
  getStakingInfo,
  getPendingRewards,
  getStakingPoolInfo,
  decodeStakingError,
  type UserStakingInfo,
  type StakingPoolInfo,
} from "./staking-service";
import { getSmartAccountAddressForUser } from "./wallet-service";
import { redactPrivateKey } from "./platform-wallet-service";
import { getPoolInfo as getAmmPoolInfo } from "./amm-service";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

// ============================================================================
// TYPES
// ============================================================================

export type StakingOrderType = "stake" | "unstake" | "claim" | "emergency_withdraw";
export type StakingOrderStatus = "pending" | "executing" | "completed" | "failed";

export interface StakingOrder {
  id: number;
  order_id: string;
  user_id: string;
  user_smart_account: string;
  order_type: StakingOrderType;
  status: StakingOrderStatus;
  amount: string;
  reward_amount: string | null;
  operator_tx_hash: string | null;
  debit_transaction_id: string | null;
  credit_transaction_id: string | null;
  reward_credit_transaction_id: string | null;
  failure_reason: string | null;
  created_at: string;
  executed_at: string | null;
  completed_at: string | null;
}

export interface StakingDashboard {
  userInfo: UserStakingInfo;
  poolInfo: StakingPoolInfo;
  tglobalBalance: string;
  recentOrders: StakingOrder[];
  /** Live PLAT → USD spot price from the AMM. `null` when the pool
   *  read fails (price-dependent UI like "(est. $X USD)" hides itself
   *  in that case). */
  platSpotPriceUsd: number | null;
}

function generateOrderId(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function requireSmartAccount(userId: string): Promise<string> {
  const sa = await getSmartAccountAddressForUser(userId);
  if (!sa) {
    throw new Error("User has no smart account. Please set up your wallet first.");
  }
  return sa;
}

// ============================================================================
// STAKE ORDER
// ============================================================================

export async function createStakeOrder(
  userId: string,
  amount: string
): Promise<StakingOrder> {
  const stakeAmount = parseFloat(amount);
  if (isNaN(stakeAmount) || stakeAmount <= 0) {
    throw new Error("Invalid stake amount");
  }

  const userSA = await requireSmartAccount(userId);

  const poolInfo = await getStakingPoolInfo();
  const minStake = parseFloat(poolInfo.minStakeAmount);
  if (stakeAmount < minStake) {
    throw new Error(`Minimum stake amount is ${minStake} PLAT`);
  }

  if (!poolInfo.depositsEnabled) {
    throw new Error("Staking deposits are currently disabled");
  }

  const availableCapacity = parseFloat(poolInfo.availableCapacity);
  if (stakeAmount > availableCapacity) {
    throw new Error(
      `Stake exceeds available capacity. Available: ${availableCapacity.toFixed(4)} PLAT`
    );
  }

  const orderId = generateOrderId();

  const debitResult = await debitBalance(userId, "PLAT", stakeAmount.toFixed(18), {
    type: "stake_lock",
    notes: `Stake order ${orderId}`,
  });

  await db.execute<ResultSetHeader>(
    `INSERT INTO staking_orders (
      order_id, user_id, user_smart_account, order_type, status,
      amount, debit_transaction_id
    ) VALUES (?, ?, ?, 'stake', 'executing', ?, ?)`,
    [orderId, userId, userSA, stakeAmount.toFixed(18), debitResult.transactionId]
  );

  try {
    const txResult = await executeOperatorStake(userSA, stakeAmount.toFixed(18));

    await db.execute(
      `UPDATE staking_orders SET
        status = 'completed',
        operator_tx_hash = ?,
        executed_at = NOW(),
        completed_at = NOW()
      WHERE order_id = ?`,
      [txResult.txHash, orderId]
    );
  } catch (error) {
    const msg = decodeStakingError(error);

    try {
      await creditBalance(userId, "PLAT", stakeAmount.toFixed(18), {
        type: "stake_unlock",
        notes: `Stake order ${orderId} failed, refunding PLAT`,
        createdBy: "operator",
      });
    } catch (refundError) {
      console.error("Stake refund failed:", refundError);
    }

    await db.execute(
      `UPDATE staking_orders SET
        status = 'failed',
        failure_reason = ?,
        completed_at = NOW()
      WHERE order_id = ?`,
      [redactPrivateKey(msg), orderId]
    );
  }

  return getOrderByOrderId(orderId);
}

// ============================================================================
// UNSTAKE ORDER
// ============================================================================

export async function createUnstakeOrder(
  userId: string,
  amount: string
): Promise<StakingOrder> {
  const unstakeAmount = parseFloat(amount);
  if (isNaN(unstakeAmount) || unstakeAmount <= 0) {
    throw new Error("Invalid unstake amount");
  }

  const userSA = await requireSmartAccount(userId);

  const userInfo = await getStakingInfo(userSA);
  const stakedAmount = parseFloat(userInfo.staked);

  if (stakedAmount < unstakeAmount) {
    throw new Error(
      `Insufficient staked balance. Staked: ${stakedAmount.toFixed(4)}, Requested: ${unstakeAmount.toFixed(4)}`
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (userInfo.lockUntil > nowSec) {
    const lockDate = new Date(userInfo.lockUntil * 1000);
    throw new Error(`Stake is locked until ${lockDate.toLocaleString()}`);
  }

  const pendingRewardsBefore = await getPendingRewards(userSA);
  const rewardAmount = parseFloat(pendingRewardsBefore);

  const orderId = generateOrderId();

  await db.execute<ResultSetHeader>(
    `INSERT INTO staking_orders (
      order_id, user_id, user_smart_account, order_type, status,
      amount, reward_amount
    ) VALUES (?, ?, ?, 'unstake', 'executing', ?, ?)`,
    [orderId, userId, userSA, unstakeAmount.toFixed(18), rewardAmount.toFixed(18)]
  );

  try {
    const txResult = await executeOperatorUnstake(userSA, unstakeAmount.toFixed(18));

    const creditResult = await creditBalance(userId, "PLAT", unstakeAmount.toFixed(18), {
      type: "stake_unlock",
      txHash: txResult.txHash,
      notes: `Unstake order ${orderId} - principal`,
      createdBy: "operator",
    });

    let rewardCreditTxId: string | null = null;
    if (rewardAmount > 0) {
      const rewardCreditResult = await creditBalance(userId, "PLAT", rewardAmount.toFixed(18), {
        type: "stake_reward",
        txHash: txResult.txHash,
        notes: `Unstake order ${orderId} - auto-claimed rewards`,
        createdBy: "operator",
      });
      rewardCreditTxId = rewardCreditResult.transactionId;
    }

    await db.execute(
      `UPDATE staking_orders SET
        status = 'completed',
        operator_tx_hash = ?,
        credit_transaction_id = ?,
        reward_credit_transaction_id = ?,
        reward_amount = ?,
        executed_at = NOW(),
        completed_at = NOW()
      WHERE order_id = ?`,
      [
        txResult.txHash,
        creditResult.transactionId,
        rewardCreditTxId,
        rewardAmount.toFixed(18),
        orderId,
      ]
    );
  } catch (error) {
    const msg = decodeStakingError(error);

    await db.execute(
      `UPDATE staking_orders SET
        status = 'failed',
        failure_reason = ?,
        completed_at = NOW()
      WHERE order_id = ?`,
      [redactPrivateKey(msg), orderId]
    );
  }

  return getOrderByOrderId(orderId);
}

// ============================================================================
// CLAIM ORDER
// ============================================================================

export async function createClaimOrder(userId: string): Promise<StakingOrder> {
  const userSA = await requireSmartAccount(userId);

  const pendingRewardsBefore = await getPendingRewards(userSA);
  const rewardAmount = parseFloat(pendingRewardsBefore);

  if (rewardAmount <= 0) {
    throw new Error("No pending rewards to claim");
  }

  const orderId = generateOrderId();

  await db.execute<ResultSetHeader>(
    `INSERT INTO staking_orders (
      order_id, user_id, user_smart_account, order_type, status,
      amount, reward_amount
    ) VALUES (?, ?, ?, 'claim', 'executing', 0, ?)`,
    [orderId, userId, userSA, rewardAmount.toFixed(18)]
  );

  try {
    const txResult = await executeOperatorClaim(userSA);

    const rewardCreditResult = await creditBalance(userId, "PLAT", rewardAmount.toFixed(18), {
      type: "stake_reward",
      txHash: txResult.txHash,
      notes: `Claim order ${orderId}`,
      createdBy: "operator",
    });

    await db.execute(
      `UPDATE staking_orders SET
        status = 'completed',
        operator_tx_hash = ?,
        reward_credit_transaction_id = ?,
        executed_at = NOW(),
        completed_at = NOW()
      WHERE order_id = ?`,
      [txResult.txHash, rewardCreditResult.transactionId, orderId]
    );
  } catch (error) {
    const msg = decodeStakingError(error);

    await db.execute(
      `UPDATE staking_orders SET
        status = 'failed',
        failure_reason = ?,
        completed_at = NOW()
      WHERE order_id = ?`,
      [redactPrivateKey(msg), orderId]
    );
  }

  return getOrderByOrderId(orderId);
}

// ============================================================================
// EMERGENCY WITHDRAW ORDER
// ============================================================================

export async function createEmergencyWithdrawOrder(
  userId: string
): Promise<StakingOrder> {
  const userSA = await requireSmartAccount(userId);

  const userInfo = await getStakingInfo(userSA);
  const stakedAmount = parseFloat(userInfo.staked);

  if (stakedAmount <= 0) {
    throw new Error("Nothing staked to withdraw");
  }

  const orderId = generateOrderId();

  await db.execute<ResultSetHeader>(
    `INSERT INTO staking_orders (
      order_id, user_id, user_smart_account, order_type, status,
      amount
    ) VALUES (?, ?, ?, 'emergency_withdraw', 'executing', ?)`,
    [orderId, userId, userSA, stakedAmount.toFixed(18)]
  );

  try {
    const txResult = await executeOperatorEmergencyWithdraw(userSA);

    const creditResult = await creditBalance(userId, "PLAT", stakedAmount.toFixed(18), {
      type: "stake_unlock",
      txHash: txResult.txHash,
      notes: `Emergency withdraw order ${orderId} - principal only (rewards forfeited)`,
      createdBy: "operator",
    });

    await db.execute(
      `UPDATE staking_orders SET
        status = 'completed',
        operator_tx_hash = ?,
        credit_transaction_id = ?,
        reward_amount = 0,
        executed_at = NOW(),
        completed_at = NOW()
      WHERE order_id = ?`,
      [txResult.txHash, creditResult.transactionId, orderId]
    );
  } catch (error) {
    const msg = decodeStakingError(error);

    await db.execute(
      `UPDATE staking_orders SET
        status = 'failed',
        failure_reason = ?,
        completed_at = NOW()
      WHERE order_id = ?`,
      [redactPrivateKey(msg), orderId]
    );
  }

  return getOrderByOrderId(orderId);
}

// ============================================================================
// QUERIES
// ============================================================================

export async function getOrderByOrderId(orderId: string): Promise<StakingOrder> {
  const [rows] = await db.execute<(RowDataPacket & StakingOrder)[]>(
    "SELECT * FROM staking_orders WHERE order_id = ?",
    [orderId]
  );
  if (rows.length === 0) throw new Error(`Staking order not found: ${orderId}`);
  return rows[0];
}

export async function getOrderHistory(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<StakingOrder[]> {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const [rows] = await db.query<(RowDataPacket & StakingOrder)[]>(
    `SELECT * FROM staking_orders
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );

  return rows;
}

/**
 * Build a combined dashboard: on-chain staking info + ledger balance + recent orders.
 *
 * Each data source is fetched independently so a single transient RPC hiccup on
 * one read does not wipe out the entire payload. Failed reads fall back to sane
 * defaults (previous values come back on the next poll) instead of throwing.
 */
export async function getStakingDashboard(
  userId: string
): Promise<StakingDashboard> {
  const userSA = await getSmartAccountAddressForUser(userId);

  const defaultUserInfo: UserStakingInfo = {
    staked: "0",
    pending: "0",
    lockUntil: 0,
    claimedLifetime: "0",
  };

  const [userInfoRes, poolInfoRes, balanceRes, ordersRes, ammPoolRes] = await Promise.allSettled([
    userSA ? getStakingInfo(userSA) : Promise.resolve(defaultUserInfo),
    getStakingPoolInfo(),
    getUserBalance(userId, "PLAT"),
    getOrderHistory(userId, 20, 0),
    getAmmPoolInfo(),
  ]);

  if (userInfoRes.status === "rejected") {
    console.error("[staking-dashboard] getStakingInfo failed:", userInfoRes.reason);
  }
  if (poolInfoRes.status === "rejected") {
    console.error("[staking-dashboard] getStakingPoolInfo failed:", poolInfoRes.reason);
  }
  if (balanceRes.status === "rejected") {
    console.error("[staking-dashboard] getUserBalance failed:", balanceRes.reason);
  }
  if (ordersRes.status === "rejected") {
    console.error("[staking-dashboard] getOrderHistory failed:", ordersRes.reason);
  }
  if (ammPoolRes.status === "rejected") {
    console.error("[staking-dashboard] AMM getPoolInfo failed:", ammPoolRes.reason);
  }

  // If the pool info read fails there is no safe default (schema is non-trivial),
  // so we surface it. Everything else has a clean fallback.
  if (poolInfoRes.status === "rejected") {
    throw poolInfoRes.reason instanceof Error
      ? poolInfoRes.reason
      : new Error("Failed to load staking pool info");
  }

  // Spot price is best-effort — failed read just hides the "(est. $X
  // USD)" suffix on the page, doesn't break the rest of the dashboard.
  let platSpotPriceUsd: number | null = null;
  if (ammPoolRes.status === "fulfilled") {
    const n = parseFloat(ammPoolRes.value.spotPrice);
    platSpotPriceUsd = Number.isFinite(n) ? n : null;
  }

  return {
    userInfo: userInfoRes.status === "fulfilled" ? userInfoRes.value : defaultUserInfo,
    poolInfo: poolInfoRes.value,
    tglobalBalance: balanceRes.status === "fulfilled" ? balanceRes.value : "0",
    recentOrders: ordersRes.status === "fulfilled" ? ordersRes.value : [],
    platSpotPriceUsd,
  };
}
