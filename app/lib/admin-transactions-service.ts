// app/lib/admin-transactions-service.ts
// Unified, read-only transaction feed for the admin panel. Merges every
// user-facing money movement into one paginated list, tagged by type:
//   buy      -> onramp_orders          (Transak on-ramp, fiat -> PLAT token)
//   sell     -> cashout_orders         (Transak off-ramp, PLAT token -> fiat)
//   convert  -> swap_transactions      (ledger token <-> token swaps)
//            +  trade_orders           (AMM buys/sells/converts of PLAT)
//   deposit  -> staking_orders (stake)
//   withdraw -> staking_orders (unstake / emergency_withdraw / claim)
//
// Each branch projects into a common 11-column shape so the rows can be
// UNION ALL'd, then filtered/sorted/paged as a single derived table. Every
// branch aliases all columns so any branch may legally appear first in the
// union (the type filter drops branches, changing which one leads).

import { adminDb } from "./db";
import { ensureUserEmailsTable } from "./user-email-service";
import type { RowDataPacket } from "mysql2/promise";

export type AdminTransactionType =
  | "buy"
  | "sell"
  | "convert"
  | "deposit"
  | "withdraw";

export interface AdminTransactionRow {
  tx_type: AdminTransactionType;
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  from_label: string | null;
  from_amount: string | null;
  to_label: string | null;
  to_amount: string | null;
  tx_hash: string | null;
  failure_reason: string | null;
  /** Login email for user_id, when known (denormalised at login). */
  user_email: string | null;
}

export interface AdminTransactionListParams {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  dateFrom?: string;
  dateTo?: string;
  type?: AdminTransactionType | "";
  userIdContains?: string;
}

const SORT_SQL: Record<string, string> = {
  created_at: "created_at",
  status: "status",
  tx_type: "tx_type",
};

const BUY_BRANCH = `
  SELECT
    'buy' AS tx_type,
    order_id AS id,
    user_id AS user_id,
    status AS status,
    created_at AS created_at,
    fiat_currency AS from_label,
    CAST(fiat_amount AS CHAR) AS from_amount,
    COALESCE(target_token, 'USDX') AS to_label,
    CAST(tusd_amount AS CHAR) AS to_amount,
    treasury_tx_hash AS tx_hash,
    failure_reason AS failure_reason
  FROM onramp_orders`;

const SELL_BRANCH = `
  SELECT
    'sell' AS tx_type,
    cashout_id AS id,
    user_id AS user_id,
    status AS status,
    created_at AS created_at,
    token AS from_label,
    CAST(token_amount AS CHAR) AS from_amount,
    fiat_currency AS to_label,
    CAST(fiat_amount AS CHAR) AS to_amount,
    COALESCE(treasury_tx_hash, operator_tx_hash) AS tx_hash,
    failure_reason AS failure_reason
  FROM cashout_orders`;

const CONVERT_SWAPS_BRANCH = `
  SELECT
    'convert' AS tx_type,
    transaction_id AS id,
    user_id AS user_id,
    status AS status,
    created_at AS created_at,
    from_token AS from_label,
    CAST(from_amount AS CHAR) AS from_amount,
    to_token AS to_label,
    CAST(to_amount AS CHAR) AS to_amount,
    NULL AS tx_hash,
    NULL AS failure_reason
  FROM swap_transactions`;

const CONVERT_TRADES_BRANCH = `
  SELECT
    'convert' AS tx_type,
    order_id AS id,
    user_id AS user_id,
    status AS status,
    created_at AS created_at,
    COALESCE(from_token, CASE WHEN order_type = 'buy' THEN fiat_currency ELSE 'PLAT' END) AS from_label,
    CAST(COALESCE(from_amount, CASE WHEN order_type = 'buy' THEN fiat_amount ELSE tglobal_amount END) AS CHAR) AS from_amount,
    COALESCE(to_token, CASE WHEN order_type = 'buy' THEN 'PLAT' ELSE fiat_currency END) AS to_label,
    CAST(COALESCE(to_amount, CASE WHEN order_type = 'buy' THEN tglobal_amount ELSE tusd_amount END) AS CHAR) AS to_amount,
    operator_tx_hash AS tx_hash,
    failure_reason AS failure_reason
  FROM trade_orders`;

const DEPOSIT_BRANCH = `
  SELECT
    'deposit' AS tx_type,
    order_id AS id,
    user_id AS user_id,
    status AS status,
    created_at AS created_at,
    'PLAT' AS from_label,
    CAST(amount AS CHAR) AS from_amount,
    NULL AS to_label,
    NULL AS to_amount,
    operator_tx_hash AS tx_hash,
    failure_reason AS failure_reason
  FROM staking_orders
  WHERE order_type = 'stake'`;

const WITHDRAW_BRANCH = `
  SELECT
    'withdraw' AS tx_type,
    order_id AS id,
    user_id AS user_id,
    status AS status,
    created_at AS created_at,
    'PLAT' AS from_label,
    CAST(amount AS CHAR) AS from_amount,
    CASE WHEN order_type = 'claim' THEN 'reward' ELSE NULL END AS to_label,
    CAST(reward_amount AS CHAR) AS to_amount,
    operator_tx_hash AS tx_hash,
    failure_reason AS failure_reason
  FROM staking_orders
  WHERE order_type IN ('unstake', 'emergency_withdraw', 'claim')`;

/** Pick only the union branches a given type filter can match, so a
 *  type-scoped query never scans the irrelevant tables. */
function branchesForType(type: AdminTransactionType | "" | undefined): string[] {
  switch (type) {
    case "buy":
      return [BUY_BRANCH];
    case "sell":
      return [SELL_BRANCH];
    case "convert":
      return [CONVERT_SWAPS_BRANCH, CONVERT_TRADES_BRANCH];
    case "deposit":
      return [DEPOSIT_BRANCH];
    case "withdraw":
      return [WITHDRAW_BRANCH];
    default:
      return [
        BUY_BRANCH,
        SELL_BRANCH,
        CONVERT_SWAPS_BRANCH,
        CONVERT_TRADES_BRANCH,
        DEPOSIT_BRANCH,
        WITHDRAW_BRANCH,
      ];
  }
}

export async function listAdminTransactions(
  params: AdminTransactionListParams = {}
): Promise<{ rows: AdminTransactionRow[]; total: number }> {
  const safeLimit = Math.max(1, Math.min(100, Number(params.limit) || 50));
  const safeOffset = Math.max(0, Number(params.offset) || 0);

  const sortKey =
    params.sortBy && SORT_SQL[params.sortBy] ? params.sortBy : "created_at";
  const orderSql = SORT_SQL[sortKey];
  const dir = params.sortDir === "asc" ? "ASC" : "DESC";

  const inner = branchesForType(params.type).join("\n  UNION ALL\n");

  const where: string[] = [];
  const values: unknown[] = [];

  if (params.dateFrom?.trim()) {
    where.push("t.created_at >= ?");
    values.push(`${params.dateFrom.trim()} 00:00:00`);
  }
  if (params.dateTo?.trim()) {
    where.push("t.created_at <= ?");
    values.push(`${params.dateTo.trim()} 23:59:59`);
  }
  const uid = params.userIdContains?.trim();
  if (uid) {
    // Match the substring against the numeric id and, when available, the
    // denormalised email. We resolve email→user_id ids up front (a separate
    // query, never a cross-table JOIN) so this can't trip MySQL "illegal mix
    // of collations" between user_emails and the order tables.
    const emailMatchedIds = await resolveUserIdsByEmail(uid);
    if (emailMatchedIds.length > 0) {
      const placeholders = emailMatchedIds.map(() => "?").join(", ");
      where.push(`(INSTR(t.user_id, ?) > 0 OR t.user_id IN (${placeholders}))`);
      values.push(uid, ...emailMatchedIds);
    } else {
      where.push("INSTR(t.user_id, ?) > 0");
      values.push(uid);
    }
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const [countRows] = await adminDb.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM (${inner}) AS t ${whereClause}`,
    values
  );
  const total = Number(countRows[0]?.cnt) || 0;

  const [rows] = await adminDb.query<(RowDataPacket & AdminTransactionRow)[]>(
    `SELECT * FROM (${inner}) AS t
     ${whereClause}
     ORDER BY t.${orderSql} ${dir}
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    values
  );

  const result = rows as AdminTransactionRow[];
  await attachUserEmails(result);
  return { rows: result, total };
}

/** Look up user_ids whose denormalised email matches the substring. Best-effort:
 *  returns [] if the lookup table is unavailable. Capped to keep the IN list sane. */
async function resolveUserIdsByEmail(substring: string): Promise<string[]> {
  try {
    await ensureUserEmailsTable();
    const [rows] = await adminDb.query<RowDataPacket[]>(
      `SELECT user_id FROM user_emails WHERE INSTR(email, ?) > 0 LIMIT 1000`,
      [substring]
    );
    return rows.map((r) => String(r.user_id));
  } catch (err) {
    console.error("[admin-tx] email→user_id lookup failed:", err);
    return [];
  }
}

/** Fill row.user_email from the lookup table via a single IN query (no JOIN, so
 *  collation differences between tables can never break the feed). Best-effort. */
async function attachUserEmails(rows: AdminTransactionRow[]): Promise<void> {
  for (const row of rows) row.user_email = null;
  const ids = [...new Set(rows.map((r) => String(r.user_id)).filter(Boolean))];
  if (ids.length === 0) return;
  try {
    await ensureUserEmailsTable();
    const placeholders = ids.map(() => "?").join(", ");
    const [emailRows] = await adminDb.query<RowDataPacket[]>(
      `SELECT user_id, email FROM user_emails WHERE user_id IN (${placeholders})`,
      ids
    );
    const byId = new Map(emailRows.map((r) => [String(r.user_id), r.email as string]));
    for (const row of rows) {
      row.user_email = byId.get(String(row.user_id)) ?? null;
    }
  } catch (err) {
    console.error("[admin-tx] attachUserEmails failed:", err);
  }
}
