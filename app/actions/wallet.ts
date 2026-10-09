// app/actions/wallet.ts
"use server";

import { getServerSession } from "@/app/lib/auth-service";
import {
  ensureWalletExists,
  getWalletByUserId,
  type InternalWallet,
} from "@/app/lib/wallet-service";

export type WalletActionResult =
  | { success: true; wallet: InternalWallet }
  | { success: false; error: string };

/**
 * Server action to get the current user's wallet
 */
export async function getMyWallet(): Promise<WalletActionResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const wallet = await getWalletByUserId(session.userId);

    if (!wallet) {
      return { success: false, error: "Wallet not found" };
    }

    return { success: true, wallet };
  } catch (error) {
    console.error("Failed to get wallet:", error);
    return { success: false, error: "Failed to retrieve wallet" };
  }
}

/**
 * Server action to ensure user has a wallet (creates one if not exists)
 */
export async function ensureMyWallet(): Promise<WalletActionResult> {
  const session = await getServerSession();

  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  try {
    const wallet = await ensureWalletExists(session.userId);
    return { success: true, wallet };
  } catch (error) {
    console.error("Failed to ensure wallet:", error);
    return { success: false, error: "Failed to create or retrieve wallet" };
  }
}

