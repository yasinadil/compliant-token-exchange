// app/actions/amm.ts
"use server";
import { UPSTREAM_API_BASE } from "@/app/lib/upstream";

import { getServerSession, getAccessToken } from "@/app/lib/auth-service";
import {
  getWalletPrivateKey,
  getSmartAccountAddressForUser,
} from "@/app/lib/wallet-service";
import {
  gaslessBatchContractCalls,
  gaslessContractCall,
  gaslessERC20Approve,
} from "@/app/lib/pimlico-service";
import {
  getPoolInfo,
  quoteSwap,
  getTokenBalances,
  type PoolInfo,
  type SwapQuote,
  type TokenBalances,
} from "@/app/lib/amm-service";
import { addresses } from "@/config/addresses";
import { AMM_ABI } from "@/config/ABI/AMM_ABI";
import { parseUnits } from "viem";
import { isTradeKycRequired } from "@/app/lib/swap-security";

const KYC_API_BASE = UPSTREAM_API_BASE;

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface KYCStatus {
  kycApproved: boolean;
  kycRequired: boolean;
}

/**
 * Check KYC status via the platform /CheckKYCStatus endpoint
 */
async function checkKycForUser(userId: string): Promise<KYCStatus> {
  const kycRequired = await isTradeKycRequired();
  if (!kycRequired) {
    console.log("[Trade KYC] KYC not required (toggle off)");
    return { kycApproved: true, kycRequired: false };
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("[Trade KYC] No access token in cookies");
    return { kycApproved: false, kycRequired: true };
  }

  try {
    const params = new URLSearchParams({ token: accessToken });
    console.log("[Trade KYC] Calling CheckKYCStatus for userId:", userId);

    const res = await fetch(`${KYC_API_BASE}/Financial/CheckKYCStatus?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[Trade KYC] API error:", res.status, res.statusText);
      return { kycApproved: false, kycRequired: true };
    }

    const body = await res.json();
    const approved = body.Status === "OK" && body.Result?.Status === "Approved";
    console.log("[Trade KYC] Result:", body.Result?.Status, "approved:", approved);

    return { kycApproved: approved, kycRequired: true };
  } catch (error) {
    console.error("[Trade KYC] Failed:", error);
    return { kycApproved: false, kycRequired: true };
  }
}

// ============ KYC CHECK (public action) ============

export async function getTradeKycStatus(): Promise<ActionResult<KYCStatus>> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }
  const kyc = await checkKycForUser(session.userId);
  return { success: true, data: kyc };
}

// ============ READ ACTIONS (no wallet needed) ============

export async function getPoolData(): Promise<ActionResult<PoolInfo>> {
  try {
    const pool = await getPoolInfo();
    return { success: true, data: pool };
  } catch (error) {
    console.error("Failed to get pool data:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to load pool data",
    };
  }
}

export async function getSwapQuote(
  tglobalIn: boolean,
  amount: string
): Promise<ActionResult<SwapQuote>> {
  try {
    if (!amount || parseFloat(amount) <= 0) {
      return { success: false, error: "Invalid amount" };
    }
    const amountIn = parseUnits(amount, 18);
    const quote = await quoteSwap(tglobalIn, amountIn);
    return { success: true, data: quote };
  } catch (error) {
    console.error("Failed to get quote:", error);
    const msg = error instanceof Error ? error.message : "Failed to get quote";
    if (msg.includes("InvalidPhase")) {
      return { success: false, error: "Pool is not active. Trading is currently disabled." };
    }
    return { success: false, error: msg };
  }
}

// ============ AUTHENTICATED READ ACTIONS ============

export async function getUserTradeInfo(): Promise<
  ActionResult<{
    balances: TokenBalances;
    kyc: KYCStatus;
    smartAccountAddress: string;
  }>
> {
  const session = await getServerSession();
  if (!session) {
    console.error("[Trade] getUserTradeInfo: No session");
    return { success: false, error: "Not authenticated" };
  }

  console.log("[Trade] getUserTradeInfo: userId =", session.userId);

  try {
    const smartAddress = await getSmartAccountAddressForUser(session.userId);
    if (!smartAddress) {
      console.error("[Trade] getUserTradeInfo: No smart account for userId", session.userId);
      return { success: false, error: "Wallet not found. Please refresh." };
    }
    console.log("[Trade] getUserTradeInfo: smartAddress =", smartAddress);

    const [balances, kyc] = await Promise.all([
      getTokenBalances(smartAddress),
      checkKycForUser(session.userId),
    ]);

    return {
      success: true,
      data: { balances, kyc, smartAccountAddress: smartAddress },
    };
  } catch (error) {
    console.error("Failed to get user trade info:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to load user data",
    };
  }
}

// ============ SWAP EXECUTION ============

export async function executeAMMSwap(
  tglobalIn: boolean,
  amount: string,
  minAmountOut: string
): Promise<ActionResult<{ txHash: string }>> {
  const session = await getServerSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!amount || parseFloat(amount) <= 0) {
    return { success: false, error: "Invalid amount" };
  }

  // KYC gate via the platform API (respects admin toggle)
  const kyc = await checkKycForUser(session.userId);
  if (kyc.kycRequired && !kyc.kycApproved) {
    return {
      success: false,
      error: "KYC verification required. Please complete identity verification before trading.",
    };
  }

  try {
    const privateKey = await getWalletPrivateKey(session.userId);
    if (!privateKey) {
      return { success: false, error: "Wallet not found" };
    }

    const smartAddress = await getSmartAccountAddressForUser(session.userId);
    if (!smartAddress) {
      return { success: false, error: "Smart account not found" };
    }

    const amountInBigInt = parseUnits(amount, 18);
    const minOutBigInt = parseUnits(minAmountOut, 18);

    // Determine input token and check allowance
    const inputToken = tglobalIn ? addresses.PLAT : addresses.USDX;
    const balances = await getTokenBalances(smartAddress);
    const currentAllowance = parseUnits(
      tglobalIn ? balances.tglobalAllowance : balances.tusdAllowance,
      0
    );

    // If allowance is insufficient, batch approve + swap
    const needsApproval =
      parseFloat(tglobalIn ? balances.tglobalAllowance : balances.tusdAllowance) <
      parseFloat(amount);

    if (needsApproval) {
      const maxApproval = BigInt(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      );
      const result = await gaslessBatchContractCalls(privateKey, [
        {
          contractAddress: inputToken,
          abi: [
            {
              name: "approve",
              type: "function",
              inputs: [
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
              ],
              outputs: [{ name: "", type: "bool" }],
            },
          ] as const,
          functionName: "approve",
          args: [addresses.AMM, maxApproval],
        },
        {
          contractAddress: addresses.AMM,
          abi: AMM_ABI,
          functionName: "swap",
          args: [tglobalIn, amountInBigInt, minOutBigInt],
        },
      ]);

      return { success: true, data: { txHash: result.txHash } };
    }

    // Allowance is sufficient, just swap
    const result = await gaslessContractCall(
      privateKey,
      addresses.AMM,
      AMM_ABI,
      "swap",
      [tglobalIn, amountInBigInt, minOutBigInt]
    );

    return { success: true, data: { txHash: result.txHash } };
  } catch (error) {
    console.error("Swap failed:", error);
    const msg = error instanceof Error ? error.message : "Swap failed";

    if (msg.includes("NotCompliant")) {
      return {
        success: false,
        error: "KYC verification required. Please complete identity verification before trading.",
      };
    }
    if (msg.includes("InvalidPhase")) {
      return {
        success: false,
        error: "Pool is not active. Trading is currently disabled.",
      };
    }
    if (msg.includes("InsufficientOutput") || msg.includes("SlippageExceeded")) {
      return {
        success: false,
        error: "Price moved too much. Try increasing slippage tolerance or reducing trade size.",
      };
    }
    if (msg.includes("InsufficientLiquidity")) {
      return {
        success: false,
        error: "Insufficient liquidity for this trade size.",
      };
    }
    if (msg.includes("TreasuryCannotSwap")) {
      return {
        success: false,
        error: "Treasury accounts are not allowed to swap.",
      };
    }
    if (msg.includes("ERC20InsufficientBalance")) {
      return {
        success: false,
        error: "Insufficient token balance for this swap.",
      };
    }

    return { success: false, error: msg };
  }
}
