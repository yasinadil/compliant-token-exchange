// app/lib/platform-wallet-service.ts
// -----------------------------------------------------------------------------
// SERVER-ONLY. Do NOT import from client components.
// -----------------------------------------------------------------------------
// Manages platform-level wallets (currently: the "operator" wallet used by
// the AMM / staking / treasury services) stored AES-256-GCM encrypted in MySQL.
//
// Replaces the previous `OPERATOR_WALLET_PRIVATE_KEY` env var. Keys are held
// only in an in-process decryption cache (60s TTL) and inside the four files
// that actually sign transactions. The private key is NEVER:
//   - returned from any server action / route handler
//   - included in any HTTP response
//   - written to logs, error messages, or failure_reason columns
//
// A build-time grep check (scripts/check-key-exposure.mjs) enforces that
// `getPlatformWalletPrivateKey` can only be referenced from:
//   app/lib/platform-wallet-service.ts    (this file)
//   app/lib/operator-service.ts
//   app/lib/staking-service.ts
//   app/lib/treasury-service.ts
// -----------------------------------------------------------------------------

import "server-only";
import { Wallet } from "ethers";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { db } from "./db";
import { encryptPrivateKey, decryptPrivateKey } from "./wallet-crypto";
import { getSmartAccountAddress } from "./pimlico-service";
import type { Hex } from "viem";

if (typeof window !== "undefined") {
  throw new Error("platform-wallet-service is server-only");
}

// ============================================================================
// TYPES
// ============================================================================

export type PlatformWalletRole = "operator";

/**
 * Public-safe shape. Contains on-chain addresses (which are public anyway via
 * BaseScan) and timestamps. This is the ONLY shape any server action ever
 * returns to the client.
 */
export interface PlatformWalletPublicInfo {
  role: PlatformWalletRole;
  walletAddress: string;
  smartAccountAddress: string;
  createdAt: Date;
  rotatedAt: Date | null;
  exists: true;
}

export type PlatformWalletStatus =
  | PlatformWalletPublicInfo
  | { exists: false };

export class PlatformWalletNotConfiguredError extends Error {
  constructor(role: PlatformWalletRole) {
    super(`Platform wallet "${role}" is not configured`);
    this.name = "PlatformWalletNotConfiguredError";
  }
}

export class PlatformWalletAlreadyExistsError extends Error {
  constructor(role: PlatformWalletRole) {
    super(`Platform wallet "${role}" already exists`);
    this.name = "PlatformWalletAlreadyExistsError";
  }
}

// ============================================================================
// IN-PROCESS DECRYPTION CACHE
// ============================================================================
// Avoid paying AES-GCM cost on every AMM trade / stake. Cache is per Node
// process, invalidated on rotate, and never persisted. Keys live only in this
// map and inside the viem wallet client that consumes them.

const CACHE_TTL_MS = 60 * 1000;
interface CachedKey {
  privateKey: string;
  expiresAt: number;
}
const privateKeyCache = new Map<PlatformWalletRole, CachedKey>();

function invalidateCache(role: PlatformWalletRole): void {
  privateKeyCache.delete(role);
}

// ============================================================================
// DB ROW TYPE (internal only, never leaves this module)
// ============================================================================

interface PlatformWalletRow extends RowDataPacket {
  id: number;
  role: PlatformWalletRole;
  wallet_address: string;
  smart_account_address: string;
  encrypted_private_key: string;
  public_key: string;
  created_by: string;
  created_at: Date;
  rotated_at: Date | null;
}

/**
 * Select without the encrypted blob. Use anywhere that returns to a caller.
 */
const SELECT_PUBLIC =
  "SELECT id, role, wallet_address, smart_account_address, public_key, created_by, created_at, rotated_at FROM platform_wallets";

function rowToPublic(row: PlatformWalletRow): PlatformWalletPublicInfo {
  return {
    role: row.role,
    walletAddress: row.wallet_address,
    smartAccountAddress: row.smart_account_address,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    exists: true,
  };
}

// ============================================================================
// PUBLIC READS
// ============================================================================

/**
 * Admin-safe metadata lookup. Never includes the private key. Callers:
 *   - app/actions/admin.ts (for the Admin Panel)
 */
export async function getPlatformWallet(
  role: PlatformWalletRole
): Promise<PlatformWalletStatus> {
  const [rows] = await db.execute<PlatformWalletRow[]>(
    `${SELECT_PUBLIC} WHERE role = ?`,
    [role]
  );
  if (rows.length === 0) return { exists: false };
  return rowToPublic(rows[0]);
}

// ============================================================================
// PRIVATE KEY LOOKUP (backend services only)
// ============================================================================

/**
 * Returns the decrypted private key bytes.
 *
 * !!! SERVER-INTERNAL ONLY !!!
 * MUST NOT be called from:
 *   - server actions (anything with "use server")
 *   - route handlers (app/api/**)
 *   - webhooks
 *   - anything that runs in the client bundle
 *
 * Allowed callers:
 *   - app/lib/operator-service.ts
 *   - app/lib/staking-service.ts
 *   - app/lib/treasury-service.ts
 *
 * A prebuild grep check enforces this list.
 */
export async function getPlatformWalletPrivateKey(
  role: PlatformWalletRole
): Promise<string> {
  const now = Date.now();
  const cached = privateKeyCache.get(role);
  if (cached && cached.expiresAt > now) {
    return cached.privateKey;
  }

  const [rows] = await db.execute<PlatformWalletRow[]>(
    `SELECT encrypted_private_key FROM platform_wallets WHERE role = ?`,
    [role]
  );
  if (rows.length === 0) {
    throw new PlatformWalletNotConfiguredError(role);
  }

  const privateKey = decryptPrivateKey(rows[0].encrypted_private_key);

  privateKeyCache.set(role, {
    privateKey,
    expiresAt: now + CACHE_TTL_MS,
  });

  return privateKey;
}

// ============================================================================
// MUTATIONS (admin-initiated only)
// ============================================================================

async function generateWalletRow(
  role: PlatformWalletRole,
  createdByUserId: string
): Promise<PlatformWalletPublicInfo> {
  const wallet = Wallet.createRandom();
  const privateKey = wallet.privateKey;
  const walletAddress = wallet.address;
  const publicKey = wallet.publicKey;

  const smartAccountAddress = await getSmartAccountAddress(privateKey as Hex);
  const encrypted = encryptPrivateKey(privateKey);

  await db.execute<ResultSetHeader>(
    `INSERT INTO platform_wallets
       (role, wallet_address, smart_account_address, encrypted_private_key, public_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      role,
      walletAddress,
      smartAccountAddress,
      encrypted,
      publicKey,
      createdByUserId,
    ]
  );

  privateKeyCache.set(role, {
    privateKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  const info = await getPlatformWallet(role);
  if (!info.exists) {
    // Defensive: we just inserted, should always exist.
    throw new Error("Platform wallet insert verification failed");
  }
  return info;
}

/**
 * Generate a brand new wallet for the given role. Fails if one already exists
 * (rotation is a separate call so it requires a distinct audit-log action).
 */
export async function createPlatformWallet(
  role: PlatformWalletRole,
  createdByUserId: string
): Promise<PlatformWalletPublicInfo> {
  const existing = await getPlatformWallet(role);
  if (existing.exists) {
    throw new PlatformWalletAlreadyExistsError(role);
  }
  return generateWalletRow(role, createdByUserId);
}

/**
 * Replace the existing wallet with a freshly generated one. The old encrypted
 * blob is overwritten; the on-chain smart account retains its funds until the
 * admin sweeps them manually.
 */
export async function rotatePlatformWallet(
  role: PlatformWalletRole,
  rotatedByUserId: string
): Promise<PlatformWalletPublicInfo> {
  const existing = await getPlatformWallet(role);
  if (!existing.exists) {
    throw new PlatformWalletNotConfiguredError(role);
  }

  const wallet = Wallet.createRandom();
  const privateKey = wallet.privateKey;
  const walletAddress = wallet.address;
  const publicKey = wallet.publicKey;

  const smartAccountAddress = await getSmartAccountAddress(privateKey as Hex);
  const encrypted = encryptPrivateKey(privateKey);

  await db.execute(
    `UPDATE platform_wallets
        SET wallet_address = ?,
            smart_account_address = ?,
            encrypted_private_key = ?,
            public_key = ?,
            created_by = ?,
            rotated_at = CURRENT_TIMESTAMP
      WHERE role = ?`,
    [
      walletAddress,
      smartAccountAddress,
      encrypted,
      publicKey,
      rotatedByUserId,
      role,
    ]
  );

  invalidateCache(role);
  privateKeyCache.set(role, {
    privateKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  const info = await getPlatformWallet(role);
  if (!info.exists) {
    throw new Error("Platform wallet rotation verification failed");
  }
  return info;
}

// ============================================================================
// REDACTION HELPER (shared)
// ============================================================================

/**
 * Strip anything that looks like a 64-hex-char private key from a string.
 * Applied to log messages and persisted failure_reason fields so a corrupted
 * error never leaks bytes that could help an attacker.
 */
export function redactPrivateKey(input: unknown): string {
  const str = typeof input === "string" ? input : String(input ?? "");
  return str.replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[REDACTED_KEY]");
}
