// app/lib/pimlico-service.ts
// Pimlico for sponsored (gasless) transactions on Base mainnet via ERC-4337
// Uses Safe smart accounts with Pimlico's verifying paymaster and bundler

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

function getPimlicoApiKey(): string {
  const apiKey = process.env.PIMLICO_API_KEY;
  if (!apiKey) {
    throw new Error("PIMLICO_API_KEY is not set");
  }
  return apiKey;
}

function getPimlicoUrl(): string {
  return `https://api.pimlico.io/v2/base/rpc?apikey=${getPimlicoApiKey()}`;
}

function getPimlicoSponsorshipPolicyId(): string | undefined {
  const policyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID;
  return policyId && policyId.trim().length > 0 ? policyId : undefined;
}

export function getBasePublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL, {
      fetchOptions: { cache: "no-store" },
    }),
  });
}

export function createWalletClientFromPrivateKey(privateKey: string) {
  const account = privateKeyToAccount(privateKey as Hex);
  return createWalletClient({
    account,
    chain: base,
    transport: http(BASE_RPC_URL),
  });
}

export function getWalletAddress(privateKey: string): Address {
  const account = privateKeyToAccount(privateKey as Hex);
  return account.address;
}

/**
 * Get the deterministic Safe smart account address for a given EOA private key.
 * This is the address that holds tokens for gasless transfers.
 */
export async function getSmartAccountAddress(
  privateKey: string
): Promise<Address> {
  const publicClient = getBasePublicClient();
  const owner = privateKeyToAccount(privateKey as Hex);

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [owner],
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
    version: "1.4.1",
  });

  return safeAccount.address;
}

/**
 * Create a Pimlico-sponsored smart account client for gasless transactions.
 * Returns a client that can send transactions with gas paid by Pimlico.
 */
async function createSponsoredClient(privateKey: string) {
  const publicClient = getBasePublicClient();
  const pimlicoUrl = getPimlicoUrl();

  const pimlicoClient = createPimlicoClient({
    chain: base,
    transport: http(pimlicoUrl),
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
  });

  const owner = privateKeyToAccount(privateKey as Hex);

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [owner],
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
    version: "1.4.1",
  });

  const sponsorshipPolicyId = getPimlicoSponsorshipPolicyId();

  const smartAccountClient = createSmartAccountClient({
    account: safeAccount,
    chain: base,
    bundlerTransport: http(pimlicoUrl),
    paymaster: pimlicoClient,
    ...(sponsorshipPolicyId
      ? { paymasterContext: { sponsorshipPolicyId } }
      : {}),
    userOperation: {
      estimateFeesPerGas: async () => {
        return (await pimlicoClient.getUserOperationGasPrice()).fast;
      },
    },
  });

  return { smartAccountClient, safeAccount };
}

// ERC20 ABI fragments
const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface TransactionResult {
  txHash: string;
  success: boolean;
}

// ============ GASLESS (SPONSORED) TRANSACTIONS VIA PIMLICO ============

/**
 * Transfer ERC20 tokens gaslessly via Pimlico-sponsored smart account.
 * Tokens must be held at the smart account address, not the EOA.
 */
export async function gaslessERC20Transfer(
  privateKey: string,
  tokenAddress: string,
  toAddress: string,
  amount: bigint
): Promise<TransactionResult> {
  const { smartAccountClient } = await createSponsoredClient(privateKey);

  const txHash = await smartAccountClient.sendTransaction({
    to: tokenAddress as Address,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddress as Address, amount],
    }),
    value: BigInt(0),
  });

  return { txHash, success: true };
}

/**
 * Approve ERC20 token spending gaslessly via Pimlico-sponsored smart account.
 */
export async function gaslessERC20Approve(
  privateKey: string,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint
): Promise<TransactionResult> {
  const { smartAccountClient } = await createSponsoredClient(privateKey);

  const txHash = await smartAccountClient.sendTransaction({
    to: tokenAddress as Address,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spenderAddress as Address, amount],
    }),
    value: BigInt(0),
  });

  return { txHash, success: true };
}

/**
 * Execute a custom contract call gaslessly via Pimlico-sponsored smart account.
 */
export async function gaslessContractCall(
  privateKey: string,
  contractAddress: string,
  abi: readonly unknown[],
  functionName: string,
  args: unknown[]
): Promise<TransactionResult> {
  const { smartAccountClient } = await createSponsoredClient(privateKey);

  const txHash = await smartAccountClient.sendTransaction({
    to: contractAddress as Address,
    data: encodeFunctionData({
      abi,
      functionName,
      args,
    }),
    value: BigInt(0),
  });

  const publicClient = getBasePublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as Hex,
  });

  return { txHash, success: receipt.status === "success" };
}

/**
 * Execute multiple contract calls in a single batched user operation.
 * All calls are atomically executed (all succeed or all revert).
 */
export async function gaslessBatchContractCalls(
  privateKey: string,
  calls: Array<{
    contractAddress: string;
    abi: readonly unknown[];
    functionName: string;
    args: unknown[];
  }>
): Promise<TransactionResult> {
  const { smartAccountClient } = await createSponsoredClient(privateKey);

  const encodedCalls = calls.map((call) => ({
    to: call.contractAddress as Address,
    data: encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    }),
    value: BigInt(0),
  }));

  const userOpHash = await smartAccountClient.sendUserOperation({
    calls: encodedCalls,
  });

  const receipt = await smartAccountClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });

  return {
    txHash: receipt.receipt.transactionHash,
    success: receipt.success,
  };
}

// ============ NATIVE ETH TRANSFER (requires gas in wallet) ============

export async function sendETH(
  privateKey: string,
  toAddress: string,
  amount: bigint
): Promise<{ hash: string; success: boolean }> {
  const walletClient = createWalletClientFromPrivateKey(privateKey);

  const hash = await walletClient.sendTransaction({
    to: toAddress as Address,
    value: amount,
  });

  return { hash, success: true };
}

export async function wrapETH(
  privateKey: string,
  amount: bigint
): Promise<{ hash: string; success: boolean }> {
  const walletClient = createWalletClientFromPrivateKey(privateKey);
  const WETH_ADDRESS =
    "0x4200000000000000000000000000000000000006" as Address;

  const hash = await walletClient.sendTransaction({
    to: WETH_ADDRESS,
    value: amount,
    data: "0xd0e30db0" as Hex,
  });

  return { hash, success: true };
}

export async function unwrapWETH(
  privateKey: string,
  amount: bigint
): Promise<{ hash: string; success: boolean }> {
  const walletClient = createWalletClientFromPrivateKey(privateKey);
  const WETH_ADDRESS =
    "0x4200000000000000000000000000000000000006" as Address;

  const data = encodeFunctionData({
    abi: [
      {
        name: "withdraw",
        type: "function",
        inputs: [{ name: "amount", type: "uint256" }],
        outputs: [],
      },
    ],
    functionName: "withdraw",
    args: [amount],
  });

  const hash = await walletClient.sendTransaction({
    to: WETH_ADDRESS,
    data,
  });

  return { hash, success: true };
}

// ============ READ FUNCTIONS (No gas needed) ============

export async function getERC20Balance(
  tokenAddress: string,
  walletAddress: string
): Promise<bigint> {
  const client = getBasePublicClient();

  const balance = await client.readContract({
    address: tokenAddress as Address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress as Address],
  });

  return balance as bigint;
}

export async function getERC20Allowance(
  tokenAddress: string,
  ownerAddress: string,
  spenderAddress: string
): Promise<bigint> {
  const client = getBasePublicClient();

  const allowance = await client.readContract({
    address: tokenAddress as Address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ownerAddress as Address, spenderAddress as Address],
  });

  return allowance as bigint;
}

export async function getETHBalance(walletAddress: string): Promise<bigint> {
  const client = getBasePublicClient();
  return client.getBalance({ address: walletAddress as Address });
}

export async function readContract<T>(
  contractAddress: string,
  abi: readonly unknown[],
  functionName: string,
  args: unknown[] = []
): Promise<T> {
  const client = getBasePublicClient();

  const result = await client.readContract({
    address: contractAddress as Address,
    abi,
    functionName,
    args,
  });

  return result as T;
}
