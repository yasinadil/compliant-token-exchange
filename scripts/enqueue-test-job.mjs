// scripts/enqueue-test-job.mjs
//
// Insert a test job into sync_outbox the same way enqueueSyncJob() does
// (bumps the per-aggregate version, writes a valid envelope). Lets you drive
// the worker without running a real trade. Connects using .env.local creds.
//
// Usage (PowerShell):
//   node scripts/enqueue-test-job.mjs
//   node scripts/enqueue-test-job.mjs trade_order INSERT TRD-TEST-1
//   node scripts/enqueue-test-job.mjs trade_order UPDATE TRD-TEST-1   # same source -> new version
//
// Args: [entity] [operation] [sourceId]
//   entity     default "trade_order"
//   operation  default "INSERT"  (INSERT|UPDATE)
//   sourceId   default "TRD-TEST-<random>"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const envPath = path.join(projectRoot, ".env.local");
  const env = {};
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnvLocal();

const entity = process.argv[2] || "trade_order";
const operation = (process.argv[3] || "INSERT").toUpperCase();
const sourceId = process.argv[4] || `TRD-TEST-${Math.random().toString(36).slice(2, 8)}`;

const conn = await mysql.createConnection({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  ssl: env.MYSQL_SSL && env.MYSQL_SSL !== "disabled" ? { rejectUnauthorized: false } : undefined,
});

// 1. Bump + read the monotonic per-aggregate version.
await conn.execute(
  `INSERT INTO sync_aggregate_version (aggregate_type, aggregate_id, version)
   VALUES (?, ?, 1)
   ON DUPLICATE KEY UPDATE version = version + 1`,
  [entity, sourceId]
);
const [verRows] = await conn.execute(
  `SELECT version FROM sync_aggregate_version WHERE aggregate_type = ? AND aggregate_id = ?`,
  [entity, sourceId]
);
const version = Number(verRows[0].version);

// 2. Build the envelope (trade_order shape; adjust data for other entities).
const jobId = randomUUID();
const envelope = {
  idempotency_key: jobId,
  source_system: env.SYNC_SOURCE_SYSTEM || "nextjs-app",
  source_id: `${entity}:${sourceId}`,
  entity,
  operation,
  version,
  occurred_at: new Date().toISOString(),
  schema_version: 1,
  data: {
    orderId: sourceId,
    userId: "u_test",
    orderType: "sell",
    status: "executing",
    fiatCurrency: "USD",
    fiatAmount: "0.00",
    tusdAmount: "10.000000000000000000",
    tglobalAmount: "10.000000000000000000",
    executedPrice: "1.020000000000000000",
    createdAt: new Date().toISOString(),
  },
};

// 3. Insert the queue row (coalesce onto an open job, like the service).
await conn.execute(
  `INSERT INTO sync_outbox
     (job_id, aggregate_type, aggregate_id, operation, aggregate_version, payload, payload_version, max_attempts)
   VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 1, 8)
   ON DUPLICATE KEY UPDATE
     aggregate_version = GREATEST(sync_outbox.aggregate_version, VALUES(aggregate_version)),
     payload = VALUES(payload), status = 'pending', attempt_count = 0,
     next_retry_at = NOW(), last_error = NULL, locked_at = NULL, locked_by = NULL`,
  [jobId, entity, sourceId, operation, version, JSON.stringify(envelope)]
);

await conn.end();

console.log(`[enqueue] job_id=${jobId}`);
console.log(`[enqueue] entity=${entity} operation=${operation} source_id=${sourceId} version=${version}`);
