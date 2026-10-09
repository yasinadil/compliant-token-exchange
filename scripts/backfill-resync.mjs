// Backfill / initial-load re-sync: rewind the CDC watermark so the scanner
// re-emits every existing row as an idempotent upsert on its next sweeps. Use
// this to (a) populate an empty downstream mirror from scratch, or (b) re-send
// rows after the v1.1 field set was expanded.
//
// SAFETY / SEQUENCING:
//   Run this ONLY AFTER the downstream (SQL Server) developer confirms the
//   v1.1 columns + updated usp_Upsert* procs are live, AND the app's
//   SYNC_API_BASE_URL points at his real endpoint (not the local mock).
//   Re-emitting into old procs would mark rows complete without the new
//   columns (and converts would dead-letter on NULL fiat), forcing a re-run.
//
// It is safe to re-run: every re-emit bumps the per-aggregate version, so the
// downstream MERGE applies (higher version passes the stale-write guard) and
// upserts on the natural key (no duplicates).
//
// Scope:
//   Default            -> all 11 entities (full initial load).
//   --entities a,b,c   -> only the named entities.
//
// Usage:
//   Dry run (default — shows impact, changes nothing):
//     node --env-file=.env.local scripts/backfill-resync.mjs
//   Commit (actually rewinds the watermark):
//     node --env-file=.env.local scripts/backfill-resync.mjs --commit
//   Only the v1.1-expanded entities:
//     node --env-file=.env.local scripts/backfill-resync.mjs --entities trade_order,cashout_order,onramp_order,staking_order,swap_transaction --commit

import mysql from "mysql2/promise";

// entity (sync_cdc_state.entity) -> source table used for the row-count estimate.
// Mirrors app/lib/sync-entities.ts. `user` is a JOIN over internal_wallets, so
// that table's count is the estimate.
const ALL_ENTITIES = [
  { entity: "trade_order", table: "trade_orders" },
  { entity: "cashout_order", table: "cashout_orders" },
  { entity: "onramp_order", table: "onramp_orders" },
  { entity: "staking_order", table: "staking_orders" },
  { entity: "ledger_transaction", table: "ledger_transactions" },
  { entity: "balance", table: "internal_balances" },
  { entity: "swap_transaction", table: "swap_transactions" },
  { entity: "checkout_charge", table: "checkout_charges" },
  { entity: "checkout_refund", table: "checkout_refunds" },
  { entity: "collected_fee", table: "collected_fees" },
  { entity: "user", table: "internal_wallets" },
];

// Optional --entities filter.
const entitiesArg = (() => {
  const i = process.argv.indexOf("--entities");
  return i !== -1 && process.argv[i + 1]
    ? process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : null;
})();

const ENTITIES = entitiesArg
  ? ALL_ENTITIES.filter((e) => entitiesArg.includes(e.entity))
  : ALL_ENTITIES;

const EPOCH = "1970-01-01 00:00:00.000";
const COMMIT = process.argv.includes("--commit");

function buildSslOption() {
  const mode = (process.env.MYSQL_SSL || "").toLowerCase();
  if (mode === "disabled" || mode === "false" || mode === "0") return undefined;
  const ca = process.env.MYSQL_SSL_CA;
  if (ca && ca.trim().length > 0) return { ca, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: buildSslOption(),
});

console.log(`Backfill re-sync — ${COMMIT ? "COMMIT" : "DRY RUN"}`);
console.log("=".repeat(48));

let totalRows = 0;
for (const { entity, table } of ENTITIES) {
  const [countRows] = await conn.query(
    `SELECT COUNT(*) AS c FROM \`${table}\``
  );
  const rowCount = Number(countRows[0].c);
  totalRows += rowCount;

  const [wmRows] = await conn.query(
    `SELECT last_watermark, last_id FROM sync_cdc_state WHERE entity = ?`,
    [entity]
  );
  const wm = wmRows.length
    ? `${wmRows[0].last_watermark} (id ${wmRows[0].last_id})`
    : "(no state row — already at epoch)";

  console.log(`\n${entity}  [${table}]`);
  console.log(`  rows to re-emit : ${rowCount}`);
  console.log(`  current watermark: ${wm}`);
}

console.log("\n" + "-".repeat(48));
console.log(`Total rows that will be re-emitted: ${totalRows}`);

if (!COMMIT) {
  console.log(
    "\nDRY RUN only — nothing changed. Re-run with --commit to rewind the watermark."
  );
  await conn.end();
  process.exit(0);
}

// Rewind: set the watermark back to epoch for these entities. The next CDC
// sweep will then re-select every row and enqueue it.
const entityNames = ENTITIES.map((e) => e.entity);
const placeholders = entityNames.map(() => "?").join(", ");
const [res] = await conn.execute(
  `UPDATE sync_cdc_state
      SET last_watermark = ?, last_id = 0
    WHERE entity IN (${placeholders})`,
  [EPOCH, ...entityNames]
);

// Any entity without a state row is already treated as epoch by the scanner,
// so no INSERT is needed — a missing row means "start from the beginning".
console.log(`\nWatermark rewound for ${res.affectedRows} entity state row(s).`);
console.log(
  "The next CDC sweep will re-emit the rows above. Monitor with:\n" +
    "  SELECT status, COUNT(*) FROM sync_outbox GROUP BY status;"
);

await conn.end();
process.exit(0);
