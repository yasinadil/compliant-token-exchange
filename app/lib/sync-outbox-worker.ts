// app/lib/sync-outbox-worker.ts
// Optional in-process worker: drains the outbox on a setInterval so jobs sync
// with lower latency than the external cron tick. Disabled by default; enable
// with OUTBOX_INPROCESS_WORKER=1. The global sweep lock (withOutboxLock) makes
// it safe to run alongside the cron route, but only enable on ONE container to
// avoid over-parallel polling.

import "server-only";
import { isSyncOutboxEnabled } from "./sync-outbox-service";
import { runSyncOutboxSweep } from "./sync-outbox-runner";

const INTERVAL_MS = Number(process.env.OUTBOX_INPROCESS_INTERVAL_MS) || 15_000;

let started = false;

export function isInProcessWorkerEnabled(): boolean {
  const flag = (process.env.OUTBOX_INPROCESS_WORKER || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * Start the in-process worker loop exactly once per process. No-op if the
 * feature or the outbox itself is disabled. Runs are non-overlapping (a busy
 * flag skips ticks while a sweep is still running) and never throw out of the
 * timer callback.
 */
export function startInProcessOutboxWorker(): void {
  if (started) return;
  if (!isInProcessWorkerEnabled() || !isSyncOutboxEnabled()) return;
  started = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runSyncOutboxSweep();
      if (result.status === "ok" && result.claimed > 0) {
        console.log(
          `[SyncOutbox] in-process sweep: claimed=${result.claimed} completed=${result.completed} retried=${result.retried} dead=${result.deadLettered}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[SyncOutbox] in-process sweep error:", msg);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();

  console.log(
    `[SyncOutbox] in-process worker started (interval=${INTERVAL_MS}ms)`
  );
}
