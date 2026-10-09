// app/lib/treasury-service.ts
// Operator wallet sends USDC (mainnet) or TRNSK (Base Sepolia) to Transak deposit addresses for off-ramp.

import "server-only";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { addresses } from "@/config/addresses";
import {
  gaslessERC20Transfer,
  getSmartAccountAddress,
  getBasePublicClient,
} from "./pimlico-service";
import {
  getPlatformWalletPrivateKey,
  PlatformWalletNotConfiguredError,
} from "./platform-wallet-service";
import { getOffRampCryptoConfig } from "./transak-service";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Load the operator private key from the DB-backed platform wallet.
 * Sanitizes errors so raw key bytes can never reach callers.
 */
async function loadOperatorPrivateKey(): Promise<string> {
  let key: string;
  try {
    key = await getPlatformWalletPrivateKey("operator");
  } catch (err) {
    if (err instanceof PlatformWalletNotConfiguredError) {
      throw new Error(
        "Operator wallet is not configured. Ask an admin to generate it in the Admin Panel."
      );
    }
    throw new Error("Operator wallet is temporarily unavailable.");
  }
  return key.startsWith("0x") ? key : `0x${key}`;
}

const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

/**
 * Send off-ramp token (USDC mainnet or TRNSK Sepolia) from operator wallet to Transak.
 */
export async function sendCryptoFromTreasury(
  toAddress: string,
  amountWei: bigint
): Promise<{ txHash: string; success: boolean }> {
  const config = getOffRampCryptoConfig();
  const privateKey = (await loadOperatorPrivateKey()) as Hex;

  if (config.isProduction) {
    const result = await gaslessERC20Transfer(
      privateKey,
      config.tokenAddress,
      toAddress,
      amountWei
    );
    return result;
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA_RPC_URL),
  });

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA_RPC_URL),
  });

  const hash = await walletClient.writeContract({
    address: config.tokenAddress as Address,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [toAddress as Address, amountWei],
  });

  await publicClient.waitForTransactionReceipt({ hash });

  return { txHash: hash, success: true };
}

/**
 * Balance of off-ramp token held by operator (EOA on Sepolia, smart account on mainnet).
 */
export async function getTreasuryCryptoBalance(): Promise<{
  raw: bigint;
  formatted: string;
  holderAddress: string;
  tokenSymbol: string;
}> {
  const config = getOffRampCryptoConfig();
  const privateKey = (await loadOperatorPrivateKey()) as Hex;

  if (config.isProduction) {
    const holder = await getSmartAccountAddress(privateKey);
    const client = getBasePublicClient();
    const balance = await client.readContract({
      address: config.tokenAddress as Address,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [holder],
    });
    const { formatUnits } = await import("viem");
    return {
      raw: balance,
      formatted: formatUnits(balance, config.decimals),
      holderAddress: holder,
      tokenSymbol: config.tokenSymbol,
    };
  }

  const account = privateKeyToAccount(privateKey);
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA_RPC_URL),
  });
  const balance = await client.readContract({
    address: config.tokenAddress as Address,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const { formatUnits } = await import("viem");
  return {
    raw: balance,
    formatted: formatUnits(balance, config.decimals),
    holderAddress: account.address,
    tokenSymbol: config.tokenSymbol,
  };
}
