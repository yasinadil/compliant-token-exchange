// app/actions/amm-admin.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import { isAdminRole } from "@/app/lib/swap-security";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { addresses } from "@/config/addresses";
import { COMPLIANCE_REGISTRY_ABI } from "@/config/ABI/COMPLIANCE_REGISTRY_ABI";
import {
  getPoolInfo,
  getImpactPolicyInfo,
  getTimelockInfo,
  getComplianceInfo,
  hasAMMRole,
  hasTimelockRole,
  type PoolInfo,
  type ImpactPolicyInfo,
  type TimelockInfo,
  type ComplianceInfo,
} from "@/app/lib/amm-service";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

async function requireAdmin() {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  if (!isAdminRole(session.roles)) throw new Error("Not authorized");
  return session;
}

// ============ READ OPERATIONS ============

export async function getContractReadData(): Promise<
  ActionResult<{
    pool: PoolInfo;
    impactPolicy: ImpactPolicyInfo;
    timelock: TimelockInfo;
  }>
> {
  try {
    await requireAdmin();

    const [pool, impactPolicy, timelock] = await Promise.all([
      getPoolInfo(),
      getImpactPolicyInfo(),
      getTimelockInfo(),
    ]);

    return { success: true, data: { pool, impactPolicy, timelock } };
  } catch (error) {
    console.error("Failed to load contract data:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to load data",
    };
  }
}

export async function getAdminRolesForAddress(
  walletAddress: string
): Promise<
  ActionResult<{
    isAMMAdmin: boolean;
    isTreasury: boolean;
    isOperator: boolean;
    isProposer: boolean;
    isExecutor: boolean;
    isCanceller: boolean;
    isComplianceOfficer: boolean;
  }>
> {
  try {
    await requireAdmin();

    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return { success: false, error: "Invalid address" };
    }

    const [
      isAMMAdmin,
      isTreasury,
      isOperator,
      isProposer,
      isExecutor,
      isCanceller,
    ] = await Promise.all([
      hasAMMRole("ADMIN_ROLE", walletAddress),
      hasAMMRole("TREASURY_ROLE", walletAddress),
      hasAMMRole("OPERATOR_ROLE", walletAddress),
      hasTimelockRole("PROPOSER_ROLE", walletAddress),
      hasTimelockRole("EXECUTOR_ROLE", walletAddress),
      hasTimelockRole("CANCELLER_ROLE", walletAddress),
    ]);

    let isComplianceOfficer = false;
    try {
      const client = createPublicClient({
        chain: base,
        transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
      });

      const roleHash = (await client.readContract({
        address: addresses.COMPLIANCE_REGISTRY as `0x${string}`,
        abi: COMPLIANCE_REGISTRY_ABI,
        functionName: "COMPLIANCE_OFFICER_ROLE",
      })) as `0x${string}`;

      isComplianceOfficer = (await client.readContract({
        address: addresses.COMPLIANCE_REGISTRY as `0x${string}`,
        abi: COMPLIANCE_REGISTRY_ABI,
        functionName: "hasRole",
        args: [roleHash, walletAddress as `0x${string}`],
      })) as boolean;
    } catch {
      // If compliance officer check fails, default to false
    }

    return {
      success: true,
      data: {
        isAMMAdmin,
        isTreasury,
        isOperator,
        isProposer,
        isExecutor,
        isCanceller,
        isComplianceOfficer,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to check roles",
    };
  }
}

export async function checkAddressCompliance(
  address: string
): Promise<ActionResult<ComplianceInfo>> {
  try {
    await requireAdmin();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return { success: false, error: "Invalid address" };
    }
    const info = await getComplianceInfo(address);
    return { success: true, data: info };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to check compliance",
    };
  }
}
