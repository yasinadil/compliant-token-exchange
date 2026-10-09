// app/lib/db.ts
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "exchange",
  waitForConnections: true,
  connectionLimit: 15,
  multipleStatements: false,
  connectTimeout: 10000,
  // Treat DATETIME columns as UTC on read and write. The MySQL server stores
  // UTC wall-clock (NOW() == UTC_TIMESTAMP() on the production host), but
  // mysql2's default is to interpret DATETIME strings using the Node.js
  // process's local TZ — so an app server running in Europe/Paris was
  // producing JS Dates two hours behind reality. Pinning the driver to 'Z'
  // keeps reads/writes timezone-correct regardless of where the app runs.
  timezone: "Z",
  // Azure Database for MySQL requires TLS; enable by default and allow
  // the operator to pin a CA via MYSQL_SSL_CA (contents) or MYSQL_SSL=disabled.
  ssl: buildSslOption(),
});

function buildSslOption(): mysql.PoolOptions["ssl"] {
  const mode = (process.env.MYSQL_SSL || "").toLowerCase();
  if (mode === "disabled" || mode === "false" || mode === "0") return undefined;

  const ca = process.env.MYSQL_SSL_CA;
  if (ca && ca.trim().length > 0) {
    return { ca, rejectUnauthorized: true };
  }
  // Default to TLS with server-side verification off; operators can pin CA
  // via MYSQL_SSL_CA for strict verification.
  return { rejectUnauthorized: false };
}

export const db = pool;
export const adminDb = pool;
export const readonlyDb = pool;

export async function getTransactionConnection() {
  const connection = await db.getConnection();
  return connection;
}

// ============================================================================
// TRANSIENT-ERROR RETRY + SIMPLE CIRCUIT BREAKER
// ============================================================================
// Azure Database for MySQL (and any managed MySQL) occasionally surfaces
// transient network / pool errors. `withMysqlRetry` retries a limited number
// of times with exponential backoff and a small breaker so callers fail fast
// when MySQL is clearly unavailable.

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "PROTOCOL_PACKETS_OUT_OF_ORDER",
  "ER_CON_COUNT_ERROR",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "POOL_CLOSED",
  "POOL_CONNLIMIT",
]);

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number; fatal?: boolean; message?: string };
  if (e.code && TRANSIENT_CODES.has(e.code)) return true;
  const msg = String(e.message || "").toLowerCase();
  if (msg.includes("read econnreset")) return true;
  if (msg.includes("pool is closed")) return true;
  if (msg.includes("connection lost")) return true;
  if (msg.includes("handshake inactivity timeout")) return true;
  return false;
}

interface BreakerState {
  failures: number;
  openedAt: number;
}

const breaker: BreakerState = { failures: 0, openedAt: 0 };
const BREAKER_TRIP_THRESHOLD = 5; // consecutive transient failures before open
const BREAKER_OPEN_MS = 15_000; // how long to stay open before probing again

export function isDatabaseCircuitOpen(): boolean {
  if (breaker.openedAt === 0) return false;
  if (Date.now() - breaker.openedAt >= BREAKER_OPEN_MS) {
    // half-open: allow probe
    return false;
  }
  return true;
}

function recordBreakerSuccess() {
  breaker.failures = 0;
  breaker.openedAt = 0;
}

function recordBreakerFailure() {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_TRIP_THRESHOLD) {
    breaker.openedAt = Date.now();
  }
}

export interface MysqlRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Retry a MySQL-backed operation on known transient errors with exponential
 * backoff. Non-transient errors propagate immediately.
 *
 * Do NOT wrap operations that have visible side effects halfway through
 * (e.g. an on-chain tx followed by a DB write). Wrap the smallest unit that
 * can be safely re-attempted.
 */
export async function withMysqlRetry<T>(
  fn: () => Promise<T>,
  opts: MysqlRetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const initialDelayMs = Math.max(10, opts.initialDelayMs ?? 150);
  const maxDelayMs = Math.max(initialDelayMs, opts.maxDelayMs ?? 2000);

  if (isDatabaseCircuitOpen()) {
    throw new DatabaseUnavailableError(
      "Database circuit breaker open — failing fast to protect downstream systems."
    );
  }

  let lastErr: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      recordBreakerSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) {
        // Not transient: do not retry, do not count towards breaker.
        throw err;
      }
      recordBreakerFailure();
      if (attempt === maxAttempts) break;
      await sleep(delay + Math.floor(Math.random() * 50));
      delay = Math.min(maxDelayMs, delay * 2);
    }
  }

  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Thrown by the retry/circuit-breaker layer when MySQL is unavailable for
 * longer than our threshold. Callers (webhook route, health probe) can
 * detect this to pick the right HTTP response.
 */
export class DatabaseUnavailableError extends Error {
  constructor(message = "Database unavailable") {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * Detect whether an arbitrary thrown error should be treated as a transient
 * MySQL failure (e.g. to surface as an HTTP 5xx so upstreams retry).
 */
export function isTransientDatabaseError(err: unknown): boolean {
  if (err instanceof DatabaseUnavailableError) return true;
  return isTransientError(err);
}

/**
 * Lightweight probe suitable for `/api/health` checks. Returns true iff a
 * trivial query completes within the pool's connect timeout.
 */
export async function pingDatabase(): Promise<{ ok: boolean; error?: string; circuitOpen: boolean }> {
  if (isDatabaseCircuitOpen()) {
    return { ok: false, error: "circuit-open", circuitOpen: true };
  }
  try {
    await db.query("SELECT 1 AS ok");
    recordBreakerSuccess();
    return { ok: true, circuitOpen: false };
  } catch (err) {
    if (isTransientError(err)) recordBreakerFailure();
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      circuitOpen: isDatabaseCircuitOpen(),
    };
  }
}
