// app/lib/sync-outbox-service.ts
// Transactional outbox for syncing local MySQL changes to the external
// MS SQL Server REST API. This module owns the queue mechanics: enqueue
// (inside a business transaction), claim, backoff/retry, dead-letter, the
// stale-lock reaper, metrics, pruning, and the global sweep lock.
//
// The actual HTTP call to the downstream API lives in sync-api-client.ts;
// the worker route (app/api/cron/sync-outbox) wires the two together.

import "server-only";
import { randomUUID } from "crypto";
import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { db, withMysqlRetry } from "./db";

// ============================================================================
// CONFIG
// ============================================================================

/** Source system identifier stamped on every envelope (for the downstream ledger). */
export const SYNC_SOURCE_SYSTEM = process.env.SYNC_SOURCE_SYSTEM || "nextjs-app";

/** Current payload contract version. Bump when the `data` shape changes. */
export const SYNC_SCHEMA_VERSION = 1;

const DEFAULT_MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 8;

// Backoff: capped exponential with full jitter (AWS-style). base * 2^(n-1),
// capped, then a uniform random in [0, raw].
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 3_600_000; // 1h

const STALE_LOCK_MINUTES = Number(process.env.OUTBOX_STALE_LOCK_MINUTES) || 5;

/**
 * Feature flag. When disabled we do NOT enqueue jobs — so the app is safe to
 * run before the downstream SQL Server API exists (no dead-letter flood). The
 * worker route also no-ops when the API base URL is unset.
 */
export function isSyncOutboxEnabled(): boolean {
  const flag = (process.env.SYNC_OUTBOX_ENABLED || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

// ============================================================================
// TYPES
// ============================================================================

export type SyncOperation = "INSERT" | "UPDATE";

/** The exact JSON body POST/PUT to the downstream API. */
export interface SyncEnvelope {
  idempotency_key: string;
  source_system: string;
  source_id: string; // composite `${entity}:${aggregateId}`
  entity: string; // routing key -> downstream table/proc
  operation: SyncOperation;
  version: number; // monotonic per-aggregate; downstream drops stale writes
  occurred_at: string; // ISO-8601 UTC
  schema_version: number;
  data: Record<string, unknown>;
}

export interface OutboxRow extends RowDataPacket {
  id: number;
  job_id: string;
  aggregate_type: string;
  aggregate_id: string;
  operation: SyncOperation;
  aggregate_version: number;
  payload: string | SyncEnvelope; // mysql2 may parse JSON columns to objects
  payload_version: number;
  status: "pending" | "processing" | "completed" | "failed" | "dead_letter";
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  remote_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueParams {
  aggregateType: string; // e.g. 'trade_order'
  aggregateId: string; // stable PK of the source row
  operation: SyncOperation;
  data: Record<string, unknown>;
  schemaVersion?: number;
  maxAttempts?: number;
}

export interface OutboxMetrics {
  counts: Record<string, number>;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
  dueNow: number;
  oldestPendingAgeSeconds: number | null;
  lastCompletedAt: string | null;
  /** Last time the worker sweep ran (from the heartbeat), null if never. */
  lastRunAt: string | null;
  /** Seconds since the last sweep; high values mean the worker is stalled/down. */
  secondsSinceLastRun: number | null;
}

/** Parsed envelope regardless of whether mysql2 handed us a string or object. */
export function parsePayload(row: OutboxRow): SyncEnvelope {
  if (typeof row.payload === "string") {
    return JSON.parse(row.payload) as SyncEnvelope;
  }
  return row.payload;
}

// ============================================================================
// ENQUEUE (called inside a business transaction)
// ============================================================================

/**
 * Enqueue a downstream sync job. MUST be called with the SAME connection/
 * transaction as the business write so the job is committed atomically with
 * the data change (the outbox guarantee).
 *
 * Returns the job_id, or null if the feature is disabled (no-op).
 *
 * The per-aggregate version is bumped here: the row lock on
 * `sync_aggregate_version` serialises concurrent enqueues for the same
 * aggregate, giving strictly increasing versions the downstream uses to drop
 * stale writes.
 */
export async function enqueueSyncJob(
  connection: PoolConnection,
  params: EnqueueParams
): Promise<string | null> {
  if (!isSyncOutboxEnabled()) return null;

  const {
    aggregateType,
    aggregateId,
    operation,
    data,
    schemaVersion = SYNC_SCHEMA_VERSION,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = params;

  // 1. Bump + read the monotonic per-aggregate version (within the tx).
  await connection.execute(
    `INSERT INTO sync_aggregate_version (aggregate_type, aggregate_id, version)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE version = version + 1`,
    [aggregateType, aggregateId]
  );
  const [verRows] = await connection.execute<RowDataPacket[]>(
    `SELECT version FROM sync_aggregate_version
      WHERE aggregate_type = ? AND aggregate_id = ?`,
    [aggregateType, aggregateId]
  );
  const version = Number(verRows[0]?.version ?? 1);

  // 2. Build the envelope.
  const jobId = randomUUID();
  const envelope: SyncEnvelope = {
    idempotency_key: jobId,
    source_system: SYNC_SOURCE_SYSTEM,
    source_id: `${aggregateType}:${aggregateId}`,
    entity: aggregateType,
    operation,
    version,
    occurred_at: new Date().toISOString(),
    schema_version: schemaVersion,
    data,
  };

  // 3. Insert the queue row. If an open (non-terminal) job already exists for
  //    this aggregate+operation, coalesce into it with the newer payload and
  //    reset it to pending — avoids piling up redundant jobs for one row.
  await connection.execute(
    `INSERT INTO sync_outbox
       (job_id, aggregate_type, aggregate_id, operation,
        aggregate_version, payload, payload_version, max_attempts)
     VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
     ON DUPLICATE KEY UPDATE
       aggregate_version = GREATEST(sync_outbox.aggregate_version, VALUES(aggregate_version)),
       payload           = VALUES(payload),
       payload_version   = VALUES(payload_version),
       status            = 'pending',
       attempt_count     = 0,
       next_retry_at     = NOW(),
       last_error        = NULL,
       locked_at         = NULL,
       locked_by         = NULL`,
    [
      jobId,
      aggregateType,
      aggregateId,
      operation,
      version,
      JSON.stringify(envelope),
      schemaVersion,
      maxAttempts,
    ]
  );

  return jobId;
}

// ============================================================================
// BACKOFF
// ============================================================================

/** Capped exponential backoff with full jitter. `attempt` is 1-based. */
export function computeBackoffMs(attempt: number): number {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(Math.random() * raw);
}

// ============================================================================
// CLAIM
// ============================================================================

/** Generate a unique worker id per sweep so claim/select never cross runs. */
export function newWorkerId(): string {
  return `${process.pid}-${randomUUID().slice(0, 8)}`;
}

/**
 * Atomically claim up to `batchSize` due jobs for this worker, then return the
 * claimed rows. attempt_count is intentionally NOT incremented here — a claim
 * is not an attempt (a crash mid-flight is recovered by the reaper without
 * burning retry budget).
 */
export async function claimDueJobs(
  workerId: string,
  batchSize: number
): Promise<OutboxRow[]> {
  await withMysqlRetry(() =>
    db.query<ResultSetHeader>(
      `UPDATE sync_outbox
          SET status = 'processing', locked_at = NOW(), locked_by = ?
        WHERE status = 'pending' AND next_retry_at <= NOW()
        ORDER BY next_retry_at ASC, id ASC
        LIMIT ?`,
      [workerId, batchSize]
    )
  );

  const [rows] = await withMysqlRetry(() =>
    db.query<OutboxRow[]>(
      `SELECT * FROM sync_outbox
        WHERE locked_by = ? AND status = 'processing'
        ORDER BY next_retry_at ASC, id ASC`,
      [workerId]
    )
  );
  return rows;
}

// ============================================================================
// OUTCOME HANDLERS
// ============================================================================

export async function markCompleted(id: number, remoteRef: string | null): Promise<void> {
  await withMysqlRetry(() =>
    db.execute(
      `UPDATE sync_outbox
          SET status = 'completed', remote_ref = ?, last_error = NULL,
              locked_at = NULL, locked_by = NULL
        WHERE id = ?`,
      [remoteRef, id]
    )
  );
}

export async function markDeadLetter(id: number, error: string): Promise<void> {
  await withMysqlRetry(() =>
    db.execute(
      `UPDATE sync_outbox
          SET status = 'dead_letter', last_error = ?,
              locked_at = NULL, locked_by = NULL
        WHERE id = ?`,
      [truncateError(error), id]
    )
  );
}

async function scheduleRetry(
  id: number,
  newAttempt: number,
  delayMs: number,
  error: string
): Promise<void> {
  const delaySec = Math.max(1, Math.round(delayMs / 1000));
  await withMysqlRetry(() =>
    db.execute(
      `UPDATE sync_outbox
          SET status = 'pending',
              attempt_count = ?,
              next_retry_at = (NOW() + INTERVAL ? SECOND),
              last_error = ?,
              locked_at = NULL, locked_by = NULL
        WHERE id = ?`,
      [newAttempt, delaySec, truncateError(error), id]
    )
  );
}

export interface FailureOutcome {
  retryable: boolean;
  error: string;
  /** Optional server-provided delay (e.g. from Retry-After), overrides backoff. */
  retryAfterMs?: number;
}

/**
 * Apply a failed attempt: dead-letter on fatal errors or exhausted retries,
 * otherwise schedule the next retry with backoff (or the server's Retry-After).
 * Returns what happened so the worker can log/summarise.
 */
export async function recordFailure(
  row: OutboxRow,
  outcome: FailureOutcome
): Promise<"dead_letter" | "retry_scheduled"> {
  const newAttempt = row.attempt_count + 1;

  if (!outcome.retryable || newAttempt >= row.max_attempts) {
    const reason = !outcome.retryable
      ? `fatal: ${outcome.error}`
      : `max attempts (${row.max_attempts}) exhausted: ${outcome.error}`;
    await markDeadLetter(row.id, reason);
    console.error(
      `[SyncOutbox] DEAD_LETTER job=${row.job_id} entity=${row.aggregate_type} id=${row.aggregate_id} reason=${reason}`
    );
    return "dead_letter";
  }

  const delayMs = outcome.retryAfterMs ?? computeBackoffMs(newAttempt);
  await scheduleRetry(row.id, newAttempt, delayMs, outcome.error);
  return "retry_scheduled";
}

// ============================================================================
// STALE-LOCK REAPER (crash recovery)
// ============================================================================

/**
 * Reset rows stuck in `processing` past the stale threshold back to `pending`
 * so a crashed worker's claims are re-processed. Returns rows recovered.
 */
export async function reapStaleLocks(minutes: number = STALE_LOCK_MINUTES): Promise<number> {
  const [res] = await withMysqlRetry(() =>
    db.execute<ResultSetHeader>(
      `UPDATE sync_outbox
          SET status = 'pending', locked_at = NULL, locked_by = NULL
        WHERE status = 'processing'
          AND locked_at < (NOW() - INTERVAL ? MINUTE)`,
      [minutes]
    )
  );
  return res.affectedRows ?? 0;
}

// ============================================================================
// DEAD-LETTER REQUEUE (manual recovery)
// ============================================================================

/** Reset a dead-letter row back to pending after the downstream bug is fixed. */
export async function requeueDeadLetter(jobId: string): Promise<boolean> {
  const [res] = await withMysqlRetry(() =>
    db.execute<ResultSetHeader>(
      `UPDATE sync_outbox
          SET status = 'pending', attempt_count = 0, next_retry_at = NOW(),
              last_error = NULL, locked_at = NULL, locked_by = NULL
        WHERE job_id = ? AND status = 'dead_letter'`,
      [jobId]
    )
  );
  return (res.affectedRows ?? 0) > 0;
}

// ============================================================================
// METRICS / OBSERVABILITY
// ============================================================================

export async function getOutboxMetrics(): Promise<OutboxMetrics> {
  const [statusRows] = await withMysqlRetry(() =>
    db.query<RowDataPacket[]>(
      `SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status`
    )
  );

  const counts: Record<string, number> = {};
  for (const r of statusRows) counts[r.status as string] = Number(r.n);

  const [aggRows] = await withMysqlRetry(() =>
    db.query<RowDataPacket[]>(
      `SELECT
          (SELECT COUNT(*) FROM sync_outbox
             WHERE status = 'pending' AND next_retry_at <= NOW()) AS due_now,
          (SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) FROM sync_outbox
             WHERE status = 'pending' AND next_retry_at <= NOW()) AS oldest_pending_age,
          (SELECT MAX(updated_at) FROM sync_outbox
             WHERE status = 'completed') AS last_completed_at,
          (SELECT last_run_at FROM sync_outbox_heartbeat WHERE id = 1) AS last_run_at,
          (SELECT TIMESTAMPDIFF(SECOND, last_run_at, NOW())
             FROM sync_outbox_heartbeat WHERE id = 1) AS secs_since_run`
    )
  );
  const agg = aggRows[0] ?? {};

  return {
    counts,
    pending: counts["pending"] ?? 0,
    processing: counts["processing"] ?? 0,
    completed: counts["completed"] ?? 0,
    failed: counts["failed"] ?? 0,
    deadLetter: counts["dead_letter"] ?? 0,
    dueNow: Number(agg.due_now ?? 0),
    oldestPendingAgeSeconds:
      agg.oldest_pending_age === null || agg.oldest_pending_age === undefined
        ? null
        : Number(agg.oldest_pending_age),
    lastCompletedAt: (agg.last_completed_at as string) ?? null,
    lastRunAt: (agg.last_run_at as string) ?? null,
    secondsSinceLastRun:
      agg.secs_since_run === null || agg.secs_since_run === undefined
        ? null
        : Number(agg.secs_since_run),
  };
}

/**
 * Update the singleton heartbeat row after a sweep. Best-effort: a heartbeat
 * write failure must never fail the sweep itself.
 */
export async function recordHeartbeat(stats: {
  status: string;
  claimed: number;
  completed: number;
  deadLettered: number;
}): Promise<void> {
  try {
    await db.execute(
      `UPDATE sync_outbox_heartbeat
          SET last_run_at = NOW(), last_status = ?, last_claimed = ?,
              last_completed = ?, last_dead = ?
        WHERE id = 1`,
      [stats.status.slice(0, 16), stats.claimed, stats.completed, stats.deadLettered]
    );
  } catch (err) {
    console.error("[SyncOutbox] heartbeat update failed:", err);
  }
}

// ============================================================================
// RETENTION / PRUNING
// ============================================================================

/** Delete completed jobs older than `days`. Returns rows removed. */
export async function pruneCompleted(
  days: number = Number(process.env.OUTBOX_RETENTION_DAYS) || 30,
  limit: number = 5000
): Promise<number> {
  const [res] = await withMysqlRetry(() =>
    db.query<ResultSetHeader>(
      `DELETE FROM sync_outbox
        WHERE status = 'completed'
          AND updated_at < (NOW() - INTERVAL ? DAY)
        LIMIT ?`,
      [days, limit]
    )
  );
  return res.affectedRows ?? 0;
}

// ============================================================================
// GLOBAL SWEEP LOCK (prevents overlapping worker runs)
// ============================================================================

const SWEEP_LOCK_NAME = "sync_outbox_worker";

/**
 * Run `fn` while holding a MySQL named lock so a slow sweep can't overlap the
 * next cron tick. GET_LOCK is connection-scoped, so we hold one dedicated
 * connection for the whole run. Returns null (without running fn) if the lock
 * is already held by another sweep.
 */
export async function withOutboxLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT GET_LOCK(?, 0) AS got`,
      [SWEEP_LOCK_NAME]
    );
    if (Number(rows[0]?.got) !== 1) {
      return null; // another sweep is running
    }
    try {
      return await fn();
    } finally {
      await connection
        .query(`SELECT RELEASE_LOCK(?)`, [SWEEP_LOCK_NAME])
        .catch(() => undefined);
    }
  } finally {
    connection.release();
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function truncateError(msg: string, max = 2000): string {
  return msg.length > max ? msg.slice(0, max) : msg;
}
