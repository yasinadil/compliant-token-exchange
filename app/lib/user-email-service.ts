// app/lib/user-email-service.ts
//
// Lightweight user_id -> email lookup used by the Admin Panel transactions
// feed. The app's own database only stores numeric user_ids; the email lives
// in the external auth service and arrives in the session at login.
//
// We denormalise it into a tiny `user_emails` table whenever a user
// authenticates, then LEFT JOIN it into the admin feed. This means a user's
// email surfaces (for both new AND historical transactions) the next time
// they log in — without touching any of the 16+ order INSERT sites.
//
// The table is created lazily and memoised per process, so neither the read
// (admin feed) nor the write (login) path depends on a manual migration.

import "server-only";
import { db } from "./db";

let ensurePromise: Promise<void> | null = null;

/** Create the lookup table if it does not exist (runs at most once per process). */
export function ensureUserEmailsTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = db
      .query(
        `CREATE TABLE IF NOT EXISTS user_emails (
           user_id    VARCHAR(255) NOT NULL PRIMARY KEY,
           email      VARCHAR(255) NOT NULL,
           updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                      ON UPDATE CURRENT_TIMESTAMP
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      )
      .then(() => undefined)
      .catch((err) => {
        // Reset so a later call can retry (e.g. DB was briefly unavailable).
        ensurePromise = null;
        throw err;
      });
  }
  return ensurePromise;
}

/**
 * Upsert a user's email. Best-effort: callers (login/register) should not let
 * a failure here block authentication, so wrap the call in try/catch.
 */
export async function recordUserEmail(
  userId: string | number | null | undefined,
  email: string | null | undefined
): Promise<void> {
  const uid = userId != null ? String(userId).trim() : "";
  const mail = typeof email === "string" ? email.trim() : "";
  if (!uid || !mail) return;

  await ensureUserEmailsTable();
  await db.query(
    `INSERT INTO user_emails (user_id, email) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email)`,
    [uid, mail]
  );
}
