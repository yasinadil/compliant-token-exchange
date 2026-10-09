"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "@/app/lib/auth-service";
import {
  createStakeOrder,
  createUnstakeOrder,
  createClaimOrder,
  createEmergencyWithdrawOrder,
  getStakingDashboard,
  getOrderHistory,
  type StakingOrder,
  type StakingDashboard,
} from "@/app/lib/staking-order-service";
import {
  getStakingPoolInfo,
  type StakingPoolInfo,
} from "@/app/lib/staking-service";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================================================
// STAKING ACTIONS
// ============================================================================

export async function stakeAction(
  amount: string
): Promise<ActionResult<StakingOrder>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!amount || parseFloat(amount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const order = await createStakeOrder(session.userId, amount);
    revalidatePath("/staking");

    if (order.status === "failed") {
      return { success: false, error: order.failure_reason || "Stake failed" };
    }

    return { success: true, data: order };
  } catch (error) {
    console.error("Failed to stake:", error);
    const msg = error instanceof Error ? error.message : "Failed to stake";

    if (msg.includes("Insufficient PLAT balance")) {
      return { success: false, error: "Insufficient PLAT balance" };
    }
    if (msg.includes("Minimum stake")) {
      return { success: false, error: msg };
    }
    if (msg.includes("deposits are currently disabled")) {
      return { success: false, error: "Staking is currently disabled" };
    }
    if (msg.includes("capacity")) {
      return { success: false, error: msg };
    }

    return { success: false, error: msg };
  }
}

export async function unstakeAction(
  amount: string
): Promise<ActionResult<StakingOrder>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    if (!amount || parseFloat(amount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }

    const order = await createUnstakeOrder(session.userId, amount);
    revalidatePath("/staking");

    if (order.status === "failed") {
      return { success: false, error: order.failure_reason || "Unstake failed" };
    }

    return { success: true, data: order };
  } catch (error) {
    console.error("Failed to unstake:", error);
    const msg = error instanceof Error ? error.message : "Failed to unstake";

    if (msg.includes("locked until")) {
      return { success: false, error: msg };
    }
    if (msg.includes("Insufficient staked balance")) {
      return { success: false, error: msg };
    }

    return { success: false, error: msg };
  }
}

export async function claimRewardsAction(): Promise<ActionResult<StakingOrder>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const order = await createClaimOrder(session.userId);
    revalidatePath("/staking");

    if (order.status === "failed") {
      return { success: false, error: order.failure_reason || "Claim failed" };
    }

    return { success: true, data: order };
  } catch (error) {
    console.error("Failed to claim rewards:", error);
    const msg = error instanceof Error ? error.message : "Failed to claim rewards";

    if (msg.includes("No pending rewards")) {
      return { success: false, error: "No pending rewards to claim" };
    }

    return { success: false, error: msg };
  }
}

export async function emergencyWithdrawAction(): Promise<ActionResult<StakingOrder>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const order = await createEmergencyWithdrawOrder(session.userId);
    revalidatePath("/staking");

    if (order.status === "failed") {
      return { success: false, error: order.failure_reason || "Emergency withdraw failed" };
    }

    return { success: true, data: order };
  } catch (error) {
    console.error("Failed to emergency withdraw:", error);
    const msg = error instanceof Error ? error.message : "Failed to emergency withdraw";
    return { success: false, error: msg };
  }
}

// ============================================================================
// READ ACTIONS
// ============================================================================

export async function getStakingInfoAction(): Promise<ActionResult<StakingDashboard>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const dashboard = await getStakingDashboard(session.userId);
    return { success: true, data: dashboard };
  } catch (error) {
    console.error("Failed to get staking info:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get staking info",
    };
  }
}

export async function getStakingPoolAction(): Promise<ActionResult<StakingPoolInfo>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const poolInfo = await getStakingPoolInfo();
    return { success: true, data: poolInfo };
  } catch (error) {
    console.error("Failed to get pool info:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get pool info",
    };
  }
}

export async function getStakingHistoryAction(
  limit: number = 50,
  offset: number = 0
): Promise<ActionResult<StakingOrder[]>> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    const orders = await getOrderHistory(session.userId, limit, offset);
    return { success: true, data: orders };
  } catch (error) {
    console.error("Failed to get staking history:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get staking history",
    };
  }
}
