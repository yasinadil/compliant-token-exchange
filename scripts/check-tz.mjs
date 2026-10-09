// scripts/check-tz.mjs
//
// One-shot diagnostic for the activity-history timezone bug. Connects to the
// same MySQL/Node.js env as the app and prints:
//   • MySQL server's @@global / @@session time_zone
//   • MySQL's NOW() vs UTC_TIMESTAMP() — gap reveals the server's offset
//   • Node.js process timezone + current Date
//   • A sample DATETIME read back through mysql2 with raw + ISO views,
//     so we can see whether mysql2 is producing the correct absolute instant
//
// Usage:
//   node scripts/check-tz.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const envPath = path.join(projectRoot, ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error(`[check-tz] .env.local not found at ${envPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnvLocal();

const connection = await mysql.createConnection({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  ssl:
    env.MYSQL_SSL && env.MYSQL_SSL !== "disabled"
      ? { rejectUnauthorized: false }
      : undefined,
});

console.log(`[check-tz] Connected to ${env.MYSQL_HOST}:${env.MYSQL_PORT} (db: ${env.MYSQL_DATABASE})\n`);

// ─── Node.js side ───────────────────────────────────────────────────────
console.log("=== Node.js process ===");
console.log("  TZ env:               ", process.env.TZ ?? "(unset)");
console.log("  Intl resolved zone:   ", Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log("  new Date():           ", new Date().toString());
console.log("  new Date().toISOString:", new Date().toISOString());
console.log("");

// ─── MySQL side ─────────────────────────────────────────────────────────
const [tzRows] = await connection.query(
  "SELECT @@global.time_zone AS gtz, @@session.time_zone AS stz, NOW() AS now_local, UTC_TIMESTAMP() AS now_utc"
);
const tz = tzRows[0];
console.log("=== MySQL server ===");
console.log("  @@global.time_zone:  ", tz.gtz);
console.log("  @@session.time_zone: ", tz.stz);
console.log("  NOW() (raw):         ", tz.now_local);
console.log("  UTC_TIMESTAMP() (raw):", tz.now_utc);
console.log("");

// If NOW() and UTC_TIMESTAMP() come back as Date objects (default mysql2
// behaviour) the .toString() above already reflects how mysql2 interpreted
// them. Print the ISO form too so the offset is unambiguous.
if (tz.now_local instanceof Date) {
  console.log("  NOW() as ISO:        ", tz.now_local.toISOString());
  console.log("  UTC_TIMESTAMP() ISO: ", tz.now_utc.toISOString());
  console.log("");
}

// ─── Sample row from a real activity table ──────────────────────────────
// trade_orders is one of the tables feeding the activity feed; created_at
// is the value the dashboard action passes to the client.
try {
  const [sampleRows] = await connection.query(
    "SELECT order_id, created_at FROM trade_orders ORDER BY created_at DESC LIMIT 1"
  );
  if (sampleRows.length > 0) {
    const r = sampleRows[0];
    console.log("=== Sample trade_orders row ===");
    console.log("  order_id:            ", r.order_id);
    console.log("  created_at (raw):    ", r.created_at);
    if (r.created_at instanceof Date) {
      console.log("  created_at.toISOString:", r.created_at.toISOString());
      console.log("  created_at.toString:  ", r.created_at.toString());
    }
  } else {
    console.log("=== Sample trade_orders row: (none) ===");
  }
} catch (err) {
  console.log("=== Sample trade_orders row: error ===");
  console.log("  ", err.message);
}

await connection.end();
