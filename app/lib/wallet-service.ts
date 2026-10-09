// app/lib/wallet-service.ts
import { Wallet } from "ethers";
import { db } from "./db";
import { getSmartAccountAddress } from "./pimlico-service";
import { encryptPrivateKey, decryptPrivateKey } from "./wallet-crypto";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

export interface InternalWallet {
  id: number;
  user_id: string;
  wallet_address: string;
  smart_account_address: string | null;
  public_key: string;
  created_at: Date;
  updated_at: Date;
}

interface WalletRow extends RowDataPacket, InternalWallet {}

/**
 * Generates a new EVM-compatible wallet
 */
export function generateWallet(): {
  address: string;
  privateKey: string;
  publicKey: string;
} {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    publicKey: wallet.publicKey,
  };
}

/**
 * Gets the wallet for a user, returns null if not found
 */
export async function getWalletByUserId(
  userId: string
): Promise<InternalWallet | null> {
  const [rows] = await db.execute<WalletRow[]>(
    "SELECT id, user_id, wallet_address, smart_account_address, public_key, created_at, updated_at FROM internal_wallets WHERE user_id = ?",
    [userId]
  );

  if (rows.length === 0) return null;
  return rows[0];
}

/**
 * Gets the decrypted private key for a wallet (use with caution!)
 */
export async function getWalletPrivateKey(userId: string): Promise<string | null> {
  const [rows] = await db.execute<(RowDataPacket & { encrypted_private_key: string })[]>(
    "SELECT encrypted_private_key FROM internal_wallets WHERE user_id = ?",
    [userId]
  );

  if (rows.length === 0) return null;
  return decryptPrivateKey(rows[0].encrypted_private_key);
}

/**
 * Creates a new wallet for a user
 */
export async function createWalletForUser(
  userId: string
): Promise<InternalWallet> {
  const existing = await getWalletByUserId(userId);
  if (existing) {
    return existing;
  }

  const { address, privateKey, publicKey } = generateWallet();
  const encryptedPrivateKey = encryptPrivateKey(privateKey);
  const smartAccountAddress = await getSmartAccountAddress(privateKey);

  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO internal_wallets (user_id, wallet_address, smart_account_address, encrypted_private_key, public_key) 
     VALUES (?, ?, ?, ?, ?)`,
    [userId, address, smartAccountAddress, encryptedPrivateKey, publicKey]
  );

  return {
    id: result.insertId,
    user_id: userId,
    wallet_address: address,
    smart_account_address: smartAccountAddress,
    public_key: publicKey,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/**
 * Gets or creates a wallet for a user, ensuring the smart account address is populated.
 */
export async function ensureWalletExists(
  userId: string
): Promise<InternalWallet> {
  let wallet = await getWalletByUserId(userId);

  if (!wallet) {
    wallet = await createWalletForUser(userId);
  }

  if (!wallet.smart_account_address) {
    const smartAddress = await getSmartAccountAddressForUser(userId);
    wallet.smart_account_address = smartAddress;
  }

  return wallet;
}

/**
 * Gets the smart account address for a user, computing and storing it if missing.
 * Handles backfill for wallets created before the smart_account_address column.
 */
export async function getSmartAccountAddressForUser(
  userId: string
): Promise<string | null> {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) return null;

  if (wallet.smart_account_address) {
    return wallet.smart_account_address;
  }

  const privateKey = await getWalletPrivateKey(userId);
  if (!privateKey) return null;

  const smartAddress = await getSmartAccountAddress(privateKey);

  await db.execute(
    "UPDATE internal_wallets SET smart_account_address = ? WHERE user_id = ?",
    [smartAddress, userId]
  );

  return smartAddress;
}

