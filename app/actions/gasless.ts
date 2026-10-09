// app/actions/gasless.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import {
  getWalletPrivateKey,
  getWalletByUserId,
  getSmartAccountAddressForUser,
} from "@/app/lib/wallet-service";
import {
  gaslessERC20Transfer,
  gaslessERC20Approve,
  gaslessContractCall,
  getERC20Balance,
  getETHBalance,
  sendETH,
} from "@/app/lib/pimlico-service";
import { parseUnits } from "viem";

export type GaslessActionResult =
  | { success: true; txHash: string }
  | { success: false; error: string };

export type WalletAddressResult =
  | { success: true; address: string }
  | { success: false; error: string };

export type SmartAccountAddressResult =
  | { success: true; address: string }
  | { success: false; error: string };

export type BalanceResult =
  | { success: true; balance: string }
  | { success: false; error: string };

export type DirectTxResult =
  | { success: true; hash: string }
  | { success: false; error: string };

/**
 * Get the EOA wallet address for the current user
 */
export async function getMyWalletAddress(): Promise<WalletAddressResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const wallet = await getWalletByUserId(session.userId);

    if (!wallet) {
      return { success: false, error: "Wallet not found" };
    }

    return { success: true, address: wallet.wallet_address };
  } catch (error) {
    console.error("Failed to get wallet address:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get wallet",
    };
  }
}

/**
 * Get the Safe smart account address for gasless operations.
 * Tokens for gasless transfers must be held at this address.
 */
export async function getMySmartAccountAddress(): Promise<SmartAccountAddressResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const address = await getSmartAccountAddressForUser(session.userId);

    if (!address) {
      return { success: false, error: "Wallet not found" };
    }

    return { success: true, address };
  } catch (error) {
    console.error("Failed to get smart account address:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to get smart account",
    };
  }
}

/**
 * Transfer ERC20 tokens gaslessly from the user's smart account.
 * Tokens must be at the smart account address (use getMySmartAccountAddress).
 */
export async function transferTokensGasless(
  tokenAddress: string,
  toAddress: string,
  amount: string,
  decimals: number = 18
): Promise<GaslessActionResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!tokenAddress || !toAddress || !amount) {
    return { success: false, error: "Missing required parameters" };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    return { success: false, error: "Invalid token address" };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    return { success: false, error: "Invalid recipient address" };
  }

  try {
    const privateKey = await getWalletPrivateKey(session.userId);

    if (!privateKey) {
      return { success: false, error: "Wallet not found" };
    }

    const amountBigInt = parseUnits(amount, decimals);

    const result = await gaslessERC20Transfer(
      privateKey,
      tokenAddress,
      toAddress,
      amountBigInt
    );

    return { success: true, txHash: result.txHash };
  } catch (error) {
    console.error("Gasless transfer failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Transaction failed",
    };
  }
}

/**
 * Approve ERC20 token spending gaslessly
 */
export async function approveTokensGasless(
  tokenAddress: string,
  spenderAddress: string,
  amount: string,
  decimals: number = 18
): Promise<GaslessActionResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!tokenAddress || !spenderAddress || !amount) {
    return { success: false, error: "Missing required parameters" };
  }

  try {
    const privateKey = await getWalletPrivateKey(session.userId);

    if (!privateKey) {
      return { success: false, error: "Wallet not found" };
    }

    const amountBigInt = parseUnits(amount, decimals);

    const result = await gaslessERC20Approve(
      privateKey,
      tokenAddress,
      spenderAddress,
      amountBigInt
    );

    return { success: true, txHash: result.txHash };
  } catch (error) {
    console.error("Gasless approve failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Approval failed",
    };
  }
}

/**
 * Execute a custom contract call gaslessly
 */
export async function executeContractGasless(
  contractAddress: string,
  abi: unknown[],
  functionName: string,
  args: unknown[]
): Promise<GaslessActionResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!contractAddress || !abi || !functionName) {
    return { success: false, error: "Missing required parameters" };
  }

  try {
    const privateKey = await getWalletPrivateKey(session.userId);

    if (!privateKey) {
      return { success: false, error: "Wallet not found" };
    }

    const result = await gaslessContractCall(
      privateKey,
      contractAddress,
      abi,
      functionName,
      args
    );

    return { success: true, txHash: result.txHash };
  } catch (error) {
    console.error("Gasless contract call failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Contract call failed",
    };
  }
}

/**
 * Get ERC20 token balance for the current user's smart account
 */
export async function getMyTokenBalance(
  tokenAddress: string,
  decimals: number = 18
): Promise<BalanceResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const smartAddress = await getSmartAccountAddressForUser(session.userId);

    if (!smartAddress) {
      return { success: false, error: "Wallet not found" };
    }

    const balance = await getERC20Balance(tokenAddress, smartAddress);
    const formatted = (Number(balance) / Math.pow(10, decimals)).toString();

    return { success: true, balance: formatted };
  } catch (error) {
    console.error("Failed to get token balance:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get balance",
    };
  }
}

/**
 * Get native ETH balance for the current user on Base
 */
export async function getMyETHBalance(): Promise<BalanceResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const wallet = await getWalletByUserId(session.userId);

    if (!wallet) {
      return { success: false, error: "Wallet not found" };
    }

    const balance = await getETHBalance(wallet.wallet_address);
    const formatted = (Number(balance) / Math.pow(10, 18)).toString();

    return { success: true, balance: formatted };
  } catch (error) {
    console.error("Failed to get ETH balance:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get balance",
    };
  }
}

/**
 * Send native ETH directly (NOT gasless - wallet pays gas)
 */
export async function sendETHDirect(
  toAddress: string,
  amount: string
): Promise<DirectTxResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  if (!toAddress || !amount) {
    return { success: false, error: "Missing required parameters" };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    return { success: false, error: "Invalid recipient address" };
  }

  try {
    const privateKey = await getWalletPrivateKey(session.userId);

    if (!privateKey) {
      return { success: false, error: "Wallet not found" };
    }

    const amountBigInt = parseUnits(amount, 18);
    const result = await sendETH(privateKey, toAddress, amountBigInt);

    return { success: true, hash: result.hash };
  } catch (error) {
    console.error("ETH transfer failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Transfer failed",
    };
  }
}
