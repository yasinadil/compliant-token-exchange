// app/lib/operator-service.ts
// Operator wallet service for executing AMM swaps on behalf of users

import "server-only";
import {
  gaslessBatchContractCalls,
  gaslessContractCall,
  getSmartAccountAddress,
  getERC20Balance,
  getERC20Allowance,
} from "./pimlico-service";
import {
  getPlatformWalletPrivateKey,
  PlatformWalletNotConfiguredError,
} from "./platform-wallet-service";
import { addresses } from "@/config/addresses";
import { AMM_ABI } from "@/config/ABI/AMM_ABI";
import { parseUnits, formatUnits, type Address } from "viem";

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

/**
 * Loads the operator private key from the DB-backed platform wallet.
 * Never logs or returns the raw bytes; callers receive a sanitized error
 * if the wallet is not configured.
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

export function getMaxSlippageBps(): number {
  return parseInt(process.env.MAX_SLIPPAGE_BPS || "200", 10);
}

export async function getOperatorSmartAccountAddress(): Promise<string> {
  const privateKey = await loadOperatorPrivateKey();
  return getSmartAccountAddress(privateKey);
}

export interface OperatorBalances {
  tusd: string;
  tglobal: string;
}

export async function getOperatorBalances(): Promise<OperatorBalances> {
  const smartAddress = await getOperatorSmartAccountAddress();

  const [tusdBal, tglobalBal] = await Promise.all([
    getERC20Balance(addresses.USDX, smartAddress),
    getERC20Balance(addresses.PLAT, smartAddress),
  ]);

  return {
    tusd: formatUnits(tusdBal, 18),
    tglobal: formatUnits(tglobalBal, 18),
  };
}

export interface OperatorSwapResult {
  txHash: string;
  success: boolean;
  amountIn: string;
  amountOut: string;
}

/**
 * Operator buys PLAT with USDX on the AMM via swapOnBehalf.
 * Tokens flow: operator -> vault -> operator. User address is for event attribution.
 */
export async function executeOperatorBuy(
  tusdAmount: string,
  minTglobalOut: string,
  userAddress: string
): Promise<OperatorSwapResult> {
  const privateKey = await loadOperatorPrivateKey();
  const smartAddress = await getSmartAccountAddress(privateKey);

  const amountIn = parseUnits(tusdAmount, 18);
  const minOut = parseUnits(minTglobalOut, 18);

  const currentAllowance = await getERC20Allowance(
    addresses.USDX,
    smartAddress,
    addresses.AMM
  );

  const needsApproval = currentAllowance < amountIn;

  let result;
  if (needsApproval) {
    result = await gaslessBatchContractCalls(privateKey, [
      {
        contractAddress: addresses.USDX,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [addresses.AMM, MAX_APPROVAL],
      },
      {
        contractAddress: addresses.AMM,
        abi: AMM_ABI,
        functionName: "swapOnBehalf",
        args: [userAddress as Address, false, amountIn, minOut],
      },
    ]);
  } else {
    result = await gaslessContractCall(
      privateKey,
      addresses.AMM,
      AMM_ABI,
      "swapOnBehalf",
      [userAddress as Address, false, amountIn, minOut]
    );
  }

  if (!result.success) {
    throw new Error(
      "AMM buy swap reverted on-chain (pool may be paused, in wrong phase, or liquidity/slippage rejected the trade)."
    );
  }

  return {
    txHash: result.txHash,
    success: result.success,
    amountIn: tusdAmount,
    amountOut: minTglobalOut,
  };
}

/**
 * Operator sells PLAT for USDX on the AMM via swapOnBehalf.
 * Tokens flow: operator -> vault -> operator. User address is for event attribution.
 */
export async function executeOperatorSell(
  tglobalAmount: string,
  minTusdOut: string,
  userAddress: string
): Promise<OperatorSwapResult> {
  const privateKey = await loadOperatorPrivateKey();
  const smartAddress = await getSmartAccountAddress(privateKey);

  const amountIn = parseUnits(tglobalAmount, 18);
  const minOut = parseUnits(minTusdOut, 18);

  const currentAllowance = await getERC20Allowance(
    addresses.PLAT,
    smartAddress,
    addresses.AMM
  );

  const needsApproval = currentAllowance < amountIn;

  let result;
  if (needsApproval) {
    result = await gaslessBatchContractCalls(privateKey, [
      {
        contractAddress: addresses.PLAT,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [addresses.AMM, MAX_APPROVAL],
      },
      {
        contractAddress: addresses.AMM,
        abi: AMM_ABI,
        functionName: "swapOnBehalf",
        args: [userAddress as Address, true, amountIn, minOut],
      },
    ]);
  } else {
    result = await gaslessContractCall(
      privateKey,
      addresses.AMM,
      AMM_ABI,
      "swapOnBehalf",
      [userAddress as Address, true, amountIn, minOut]
    );
  }

  if (!result.success) {
    throw new Error(
      "AMM sell swap reverted on-chain (pool may be paused, in wrong phase, or liquidity/slippage rejected the trade)."
    );
  }

  return {
    txHash: result.txHash,
    success: result.success,
    amountIn: tglobalAmount,
    amountOut: minTusdOut,
  };
}
