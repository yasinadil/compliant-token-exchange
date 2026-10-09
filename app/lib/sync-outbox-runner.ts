// app/lib/sync-outbox-runner.ts
// The worker "sweep": claim due jobs, deliver each to the downstream API, and
// apply completion / retry / dead-letter. Shared by the cron route
// (app/api/cron/sync-outbox) and the optional in-process worker so both drive
// identical logic against the same sync_outbox table.

import "server-only";
import {
  isSyncOutboxEnabled,
  withOutboxLock,
  reapStaleLocks,
  claimDueJobs,
  newWorkerId,
  markCompleted,
  recordFailure,
  recordHeartbeat,
  parsePayload,
} from "./sync-outbox-service";
import { isSyncApiConfigured, sendSyncJob } from "./sync-api-client";
import { isCdcEnabled, runCdcScan } from "./sync-cdc-service";

const DEFAULT_BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE) || 50;

export type SweepStatus = "ok" | "disabled" | "no_api" | "locked";

export interface SweepResult {
  status: SweepStatus;
  /** Rows the CDC scanner enqueued this sweep (0 if CDC disabled). */
  cdcEnqueued: number;
  reaped: number;
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  elapsedMs: number;
}

/**
 * Run one drain of the queue. Guarded by a global lock so concurrent sweeps
 * (overlapping cron ticks, cron + in-process worker) never double-process.
 */
export async function runSyncOutboxSweep(opts?: {
  batchSize?: number;
}): Promise<SweepResult> {
  const started = Date.now();
  const base: Omit<SweepResult, "status" | "elapsedMs"> = {
    cdcEnqueued: 0,
    reaped: 0,
    claimed: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
  };

  if (!isSyncOutboxEnabled()) {
    return { status: "disabled", ...base, elapsedMs: Date.now() - started };
  }
  if (!isSyncApiConfigured()) {
    return { status: "no_api", ...base, elapsedMs: Date.now() - started };
  }

  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;

  const result = await withOutboxLock(async () => {
    // Phase 1 — CDC: enqueue rows changed since the last watermark, so the
    // outbox reflects every business-table change (compliance completeness).
    let cdcEnqueued = 0;
    if (isCdcEnabled()) {
      const cdc = await runCdcScan();
      cdcEnqueued = cdc.totalEnqueued;
    }

    // Phase 2 — drain: deliver due jobs downstream.
    const reaped = await reapStaleLocks();
    const workerId = newWorkerId();
    const jobs = await claimDueJobs(workerId, batchSize);

    let completed = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const row of jobs) {
      try {
        const envelope = parsePayload(row);
        const res = await sendSyncJob(envelope);

        if (res.outcome === "success") {
          await markCompleted(row.id, res.remoteRef ?? null);
          completed += 1;
        } else {
          const outcome = await recordFailure(row, {
            retryable: res.outcome === "retryable",
            error: res.error ?? `HTTP ${res.status ?? "?"}`,
            retryAfterMs: res.retryAfterMs,
          });
          if (outcome === "dead_letter") deadLettered += 1;
          else retried += 1;
        }
      } catch (err) {
        // Unexpected worker-side error: treat as retryable so the job isn't lost.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SyncOutbox] worker error job=${row.job_id}: ${msg}`);
        const outcome = await recordFailure(row, {
          retryable: true,
          error: `worker: ${msg}`,
        }).catch(() => "retry_scheduled" as const);
        if (outcome === "dead_letter") deadLettered += 1;
        else retried += 1;
      }
    }

    return {
      cdcEnqueued,
      reaped,
      claimed: jobs.length,
      completed,
      retried,
      deadLettered,
    };
  });

  if (result === null) {
    // Another sweep holds the lock — nothing to do.
    return { status: "locked", ...base, elapsedMs: Date.now() - started };
  }

  // Heartbeat: record that the worker actually ran (best-effort).
  await recordHeartbeat({
    status: "ok",
    claimed: result.claimed,
    completed: result.completed,
    deadLettered: result.deadLettered,
  });

  return { status: "ok", ...result, elapsedMs: Date.now() - started };
}
