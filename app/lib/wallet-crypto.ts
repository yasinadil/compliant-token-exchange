// app/lib/wallet-crypto.ts
// Server-only AES-256-GCM helpers for encrypting/decrypting private keys
// at rest (internal_wallets, platform_wallets). Extracted from the original
// wallet-service.ts so every table that stores encrypted keys uses the exact
// same primitives.
//
// Do NOT import this from a client component. `import "server-only"` ensures
// the build fails if that ever happens.

import "server-only";
import crypto from "crypto";

if (typeof window !== "undefined") {
  throw new Error("wallet-crypto is server-only");
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.WALLET_ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypt a plaintext private key with AES-256-GCM.
 * Format: `${iv}:${authTag}:${encrypted}` (all hex-encoded).
 */
export function encryptPrivateKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt a previously-encrypted key. Throws on tampered ciphertext.
 */
export function decryptPrivateKey(encryptedData: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, encrypted] = encryptedData.split(":");

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
