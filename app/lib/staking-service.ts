// app/lib/staking-service.ts
// Operator staking service for delegated staking via Pimlico gasless transactions

import "server-only";
import {
  gaslessBatchContractCalls,
  gaslessContractCall,
  getSmartAccountAddress,
  getERC20Allowance,
  getERC20Balance,
  readContract,
  getBasePublicClient,
} from "./pimlico-service";
import {
  getPlatformWalletPrivateKey,
  PlatformWalletNotConfiguredError,
} from "./platform-wallet-service";
import { addresses } from "@/config/addresses";
import { STAKING_ABI } from "@/config/ABI/STAKING_ABI";
import { parseUnits, formatUnits, decodeErrorResult, type Address, type Hex } from "viem";

const MAX_APPROVAL = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
);

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const STAKING_ERROR_MESSAGES: Record<string, string> = {
  DepositsDisabled: "Staking deposits are currently disabled.",
  BelowMinimumStake: "Amount is below the minimum stake requirement.",
  CapacityFull: "The staking pool is at full capacity.",
  UserCapExceeded: "This stake would exceed the maximum stake per user.",
  NotCompliant: "User is not compliant. Please complete KYC verification.",
  InsufficientStake: "Insufficient staked balance for this withdrawal.",
  StillLocked: "Your stake is still locked. Please wait until the lock period ends.",
  NothingStaked: "No active stake found to withdraw.",
  BucketExhausted: "The reward budget has been exhausted.",
  MonthlyCapExceeded: "Monthly reward emission cap has been reached. Try again next epoch.",
  InsufficientFundedRewards: "Insufficient funded rewards in the contract.",
  NotInitialized: "The staking contract has not been initialized.",
  InvalidAmount: "Invalid staking amount.",
  ZeroAddress: "Invalid address provided.",
  ExceedsGuardrail: "The requested parameter exceeds safety guardrails.",
  AccessControlUnauthorizedAccount: "The operator is not authorized for this action. Contact support.",
  EnforcedPause: "The staking contract is currently paused for maintenance.",
  SafeERC20FailedOperation: "Token transfer failed. The operator wallet may have insufficient PLAT.",
  ERC20InsufficientAllowance: "Token approval insufficient. Please try again — approval is handled automatically.",
  ERC20InsufficientBalance: "Operator wallet has insufficient PLAT balance. Please contact support.",
};

const ERC20_ERROR_ABI = [
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
] as const;

const ALL_ERROR_ABIS = [...STAKING_ABI, ...ERC20_ERROR_ABI];

/**
 * Attempt to decode a contract revert error into a user-friendly message.
 * Handles: viem ContractFunctionRevertedError, raw hex in error messages, and known string patterns.
 */
export function decodeStakingError(error: unknown): string {
  if (!(error instanceof Error)) return "An unexpected error occurred.";

  const msg = error.message;

  // Try to extract and decode raw revert data from the error.
  // Viem errors often embed hex data like "reason: 0xABCD1234..." or "signature: 0xABCD1234..."
  const hexMatch = msg.match(/(?:reason|signature):\s*(0x[0-9a-fA-F]{8,})/);
  if (hexMatch && hexMatch[1] && hexMatch[1] !== "0x") {
    try {
      const decoded = decodeErrorResult({
        abi: ALL_ERROR_ABIS,
        data: hexMatch[1] as Hex,
      });
      const friendly = STAKING_ERROR_MESSAGES[decoded.errorName];
      if (friendly) return friendly;
      return `Contract error: ${decoded.errorName}`;
    } catch {
      // Couldn't decode - fall through
    }
  }

  // Check for "data" property on the error (viem attaches this on some errors)
  const anyError = error as unknown as Record<string, unknown>;
  if (anyError.data && typeof anyError.data === "string" && (anyError.data as string).startsWith("0x")) {
    try {
      const decoded = decodeErrorResult({
        abi: ALL_ERROR_ABIS,
        data: anyError.data as Hex,
      });
      const friendly = STAKING_ERROR_MESSAGES[decoded.errorName];
      if (friendly) return friendly;
      return `Contract error: ${decoded.errorName}`;
    } catch {
      // fall through
    }
  }

  // Check for known error name patterns directly in the message
  for (const [errorName, friendlyMsg] of Object.entries(STAKING_ERROR_MESSAGES)) {
    if (msg.includes(errorName)) return friendlyMsg;
  }

  // Common bundler/UserOp patterns
  if (msg.includes("reverted during simulation with reason: 0x")) {
    return "Transaction simulation failed. The operator wallet may have insufficient PLAT balance, or a contract condition was not met. Please try again or contact support.";
  }
  if (msg.includes("AA21") || msg.includes("didn't pay prefund")) {
    return "Gas sponsorship failed. Please try again later.";
  }
  if (msg.includes("AA25") || msg.includes("nonce")) {
    return "Transaction nonce conflict. Please try again.";
  }

  return msg;
}

/**
 * Pre-flight validation before sending a staking UserOperation.
 * Checks on-chain state to provide clear errors instead of opaque bundler reverts.
 */
async function preflightStakeChecks(
  operatorSA: string,
  userSA: string,
  amount: bigint
): Promise<void> {
  const [operatorBalance, poolInfo, depositsEnabled, minStakeAmount, userStake, maxStakePerUser] = await Promise.all([
    getERC20Balance(addresses.PLAT, operatorSA),
    readContract<readonly [bigint, bigint, bigint, bigint]>(
      addresses.STAKING, STAKING_ABI, "getCapacityInfo", []
    ),
    readContract<boolean>(addresses.STAKING, STAKING_ABI, "depositsEnabled", []),
    readContract<bigint>(addresses.STAKING, STAKING_ABI, "minStakeAmount", []),
    readContract<readonly [bigint, bigint, bigint, bigint, bigint]>(
      addresses.STAKING, STAKING_ABI, "stakes", [userSA as Address]
    ),
    readContract<bigint>(addresses.STAKING, STAKING_ABI, "maxStakePerUser", []),
  ]);

  if (!depositsEnabled) {
    throw new Error("Staking deposits are currently disabled.");
  }
  if (amount < minStakeAmount) {
    throw new Error(`Amount is below the minimum stake of ${formatUnits(minStakeAmount, 18)} PLAT.`);
  }
  if (operatorBalance < amount) {
    throw new Error(
      `Operator wallet has insufficient PLAT (has ${formatUnits(operatorBalance, 18)}, needs ${formatUnits(amount, 18)}). Please contact support.`
    );
  }
  const availableCapacity = poolInfo[2];
  if (amount > availableCapacity) {
    throw new Error(
      `Stake exceeds available pool capacity. Available: ${formatUnits(availableCapacity, 18)} PLAT.`
    );
  }
  const currentUserStake = userStake[0];
  if (currentUserStake + amount > maxStakePerUser) {
    throw new Error(
      `This stake would exceed the maximum per user (${formatUnits(maxStakePerUser, 18)} PLAT). You currently have ${formatUnits(currentUserStake, 18)} staked.`
    );
  }

  // Simulate the contract call to catch remaining issues (compliance, authorization, etc.)
  // We ignore ERC20InsufficientAllowance since approval is handled in the batched UserOp.
  const publicClient = getBasePublicClient();
  try {
    await publicClient.simulateContract({
      address: addresses.STAKING as Address,
      abi: STAKING_ABI,
      functionName: "stakeFor",
      args: [userSA as Address, amount],
      account: operatorSA as Address,
    });
  } catch (simError) {
    const simMsg = simError instanceof Error ? simError.message : "";
    const isAllowanceError =
      simMsg.includes("0xfb8f41b2") ||
      simMsg.includes("ERC20InsufficientAllowance") ||
      simMsg.includes("insufficient allowance");
    if (!isAllowanceError) {
      const decoded = decodeStakingError(simError);
      throw new Error(decoded);
    }
  }
}

async function preflightUnstakeChecks(
  userSA: string,
  amount: bigint
): Promise<void> {
  const userStake = await readContract<readonly [bigint, bigint, bigint, bigint, bigint]>(
    addresses.STAKING, STAKING_ABI, "stakes", [userSA as Address]
  );
  const stakedAmount = userStake[0];
  const lockUntil = userStake[3];

  if (stakedAmount < amount) {
    throw new Error(
      `Insufficient staked balance. Staked: ${formatUnits(stakedAmount, 18)}, Requested: ${formatUnits(amount, 18)}`
    );
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (nowSec < lockUntil) {
    const lockDate = new Date(Number(lockUntil) * 1000);
    throw new Error(`Your stake is locked until ${lockDate.toLocaleString()}.`);
  }
}

/**
 * Loads the operator private key from the DB-backed platform wallet.
 * Sanitizes errors so the raw key bytes can never surface to callers.
 */
async function loadOperatorPrivateKey(): Promise<string> {
  try {
    return await getPlatformWalletPrivateKey("operator");
  } catch (err) {
    if (err instanceof PlatformWalletNotConfiguredError) {
      throw new Error(
        "Operator wallet is not configured. Ask an admin to generate it in the Admin Panel."
      );
    }
    throw new Error("Operator wallet is temporarily unavailable.");
  }
}

async function getOperatorSmartAccountAddress(): Promise<string> {
  const privateKey = await loadOperatorPrivateKey();
  return getSmartAccountAddress(privateKey);
}

// ============================================================================
// WRITE OPERATIONS (Operator-delegated, gasless via Pimlico)
// ============================================================================

export interface StakingTxResult {
  txHash: string;
  success: boolean;
}

/**
 * Operator stakes PLAT on behalf of a user.
 * Approves the staking contract if needed, then calls stakeFor(userSA, amount).
 */
export async function executeOperatorStake(
  userSA: string,
  amount: string
): Promise<StakingTxResult> {
  const privateKey = await loadOperatorPrivateKey();
  const smartAddress = await getSmartAccountAddress(privateKey);
  const parsedAmount = parseUnits(amount, 18);

  await preflightStakeChecks(smartAddress, userSA, parsedAmount);

  const currentAllowance = await getERC20Allowance(
    addresses.PLAT,
    smartAddress,
    addresses.STAKING
  );

  const needsApproval = currentAllowance < parsedAmount;

  try {
    let result;
    if (needsApproval) {
      result = await gaslessBatchContractCalls(privateKey, [
        {
          contractAddress: addresses.PLAT,
          abi: ERC20_APPROVE_ABI,
          functionName: "approve",
          args: [addresses.STAKING, MAX_APPROVAL],
        },
        {
          contractAddress: addresses.STAKING,
          abi: STAKING_ABI,
          functionName: "stakeFor",
          args: [userSA as Address, parsedAmount],
        },
      ]);
    } else {
      result = await gaslessContractCall(
        privateKey,
        addresses.STAKING,
        STAKING_ABI,
        "stakeFor",
        [userSA as Address, parsedAmount]
      );
    }

    return { txHash: result.txHash, success: result.success };
  } catch (error) {
    throw new Error(decodeStakingError(error));
  }
}

/**
 * Operator unstakes PLAT on behalf of a user.
 * Calls unstakeFor(userSA, amount). This auto-claims pending rewards.
 */
export async function executeOperatorUnstake(
  userSA: string,
  amount: string
): Promise<StakingTxResult> {
  const privateKey = await loadOperatorPrivateKey();
  const parsedAmount = parseUnits(amount, 18);

  await preflightUnstakeChecks(userSA, parsedAmount);

  try {
    const result = await gaslessContractCall(
      privateKey,
      addresses.STAKING,
      STAKING_ABI,
      "unstakeFor",
      [userSA as Address, parsedAmount]
    );

    return { txHash: result.txHash, success: result.success };
  } catch (error) {
    throw new Error(decodeStakingError(error));
  }
}

/**
 * Operator claims staking rewards on behalf of a user.
 * Calls claimFor(userSA). Rewards are sent to the operator SA.
 */
export async function executeOperatorClaim(
  userSA: string
): Promise<StakingTxResult> {
  const privateKey = await loadOperatorPrivateKey();

  try {
    const result = await gaslessContractCall(
      privateKey,
      addresses.STAKING,
      STAKING_ABI,
      "claimFor",
      [userSA as Address]
    );

    return { txHash: result.txHash, success: result.success };
  } catch (error) {
    throw new Error(decodeStakingError(error));
  }
}

/**
 * Operator emergency withdraws on behalf of a user (forfeits rewards).
 * Calls emergencyWithdrawFor(userSA).
 */
export async function executeOperatorEmergencyWithdraw(
  userSA: string
): Promise<StakingTxResult> {
  const privateKey = await loadOperatorPrivateKey();

  try {
    const result = await gaslessContractCall(
      privateKey,
      addresses.STAKING,
      STAKING_ABI,
      "emergencyWithdrawFor",
      [userSA as Address]
    );

    return { txHash: result.txHash, success: result.success };
  } catch (error) {
    throw new Error(decodeStakingError(error));
  }
}

// ============================================================================
// READ OPERATIONS (No gas needed)
// ============================================================================

export interface UserStakingInfo {
  staked: string;
  pending: string;
  lockUntil: number;
  claimedLifetime: string;
}

/**
 * Get on-chain staking info for a user's smart account.
 */
export async function getStakingInfo(
  userSA: string
): Promise<UserStakingInfo> {
  const result = await readContract<readonly [bigint, bigint, bigint, bigint]>(
    addresses.STAKING,
    STAKING_ABI,
    "getUserInfo",
    [userSA as Address]
  );

  return {
    staked: formatUnits(result[0], 18),
    pending: formatUnits(result[1], 18),
    lockUntil: Number(result[2]),
    claimedLifetime: formatUnits(result[3], 18),
  };
}

/**
 * Get pending rewards for a user's smart account.
 */
export async function getPendingRewards(userSA: string): Promise<string> {
  const result = await readContract<bigint>(
    addresses.STAKING,
    STAKING_ABI,
    "pendingRewards",
    [userSA as Address]
  );

  return formatUnits(result, 18);
}

export interface StakingPoolInfo {
  maxCapacity: string;
  totalStaked: string;
  availableCapacity: string;
  utilizationBps: number;
  rewardBucket: string;
  cumulativeDistributed: string;
  remainingBudget: string;
  currentApyBps: number;
  epochStart: number;
  epochEmissions: string;
  monthlyEmissionCap: string;
  nextEpochTimestamp: number;
  depositsEnabled: boolean;
  minStakeAmount: string;
  minLockDuration: number;
}

/**
 * Get full staking pool dashboard info from on-chain.
 */
export async function getStakingPoolInfo(): Promise<StakingPoolInfo> {
  const [capacityInfo, rewardInfo, epochInfo, depositsEnabled, minStakeAmount, minLockDuration] =
    await Promise.all([
      readContract<readonly [bigint, bigint, bigint, bigint]>(
        addresses.STAKING,
        STAKING_ABI,
        "getCapacityInfo",
        []
      ),
      readContract<readonly [bigint, bigint, bigint, bigint]>(
        addresses.STAKING,
        STAKING_ABI,
        "getRewardInfo",
        []
      ),
      readContract<readonly [bigint, bigint, bigint, bigint]>(
        addresses.STAKING,
        STAKING_ABI,
        "getEpochInfo",
        []
      ),
      readContract<boolean>(addresses.STAKING, STAKING_ABI, "depositsEnabled", []),
      readContract<bigint>(addresses.STAKING, STAKING_ABI, "minStakeAmount", []),
      readContract<bigint>(addresses.STAKING, STAKING_ABI, "minLockDuration", []),
    ]);

  return {
    maxCapacity: formatUnits(capacityInfo[0], 18),
    totalStaked: formatUnits(capacityInfo[1], 18),
    availableCapacity: formatUnits(capacityInfo[2], 18),
    utilizationBps: Number(capacityInfo[3]),
    rewardBucket: formatUnits(rewardInfo[0], 18),
    cumulativeDistributed: formatUnits(rewardInfo[1], 18),
    remainingBudget: formatUnits(rewardInfo[2], 18),
    currentApyBps: Number(rewardInfo[3]),
    epochStart: Number(epochInfo[0]),
    epochEmissions: formatUnits(epochInfo[1], 18),
    monthlyEmissionCap: formatUnits(epochInfo[2], 18),
    nextEpochTimestamp: Number(epochInfo[3]),
    depositsEnabled,
    minStakeAmount: formatUnits(minStakeAmount, 18),
    minLockDuration: Number(minLockDuration),
  };
}
