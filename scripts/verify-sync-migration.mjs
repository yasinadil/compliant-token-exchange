// Verify migration 023 is applied on Railway MySQL.
// Run: node --env-file=.env.local scripts/verify-sync-migration.mjs

import mysql from "mysql2/promise";

const required = [
  "sync_outbox",
  "sync_aggregate_version",
  "sync_outbox_heartbeat",
  "sync_cdc_state",
];

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

const [tables] = await conn.query("SHOW TABLES LIKE 'sync_%'");
const found = tables.map((r) => Object.values(r)[0]);
const missing = required.filter((t) => !found.includes(t));

const counts = {};
for (const t of required) {
  if (found.includes(t)) {
    const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    counts[t] = rows[0].c;
  }
}

const [cols] = await conn.query(
  `SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME IN ('staking_orders', 'checkout_charges')
      AND COLUMN_NAME = 'updated_at'`,
  [process.env.MYSQL_DATABASE]
);

await conn.end();

console.log("Sync migration verification");
console.log("===========================");
console.log("Tables found:", found.join(", ") || "(none)");
console.log("Missing:", missing.length ? missing.join(", ") : "none");
console.log("Row counts:", counts);
console.log("updated_at columns:", cols.map((c) => c.TABLE_NAME).join(", ") || "none");

process.exit(missing.length ? 1 : 0);
