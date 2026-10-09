// app/actions/sync-outbox.ts
"use server";

// Admin-facing actions for the downstream sync outbox: inspect queue health
// (depth, lag, dead-letter count) and manually requeue a dead-lettered job
// once the downstream issue is fixed.

import { getServerSession } from "@/app/lib/auth-service";
import {
  getOutboxMetrics,
  requeueDeadLetter,
  type OutboxMetrics,
} from "@/app/lib/sync-outbox-service";

type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

async function requireAdminSession(): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getServerSession();
  if (!session) return { ok: false, error: "Not authenticated" };
  if (!session.roles?.includes("Admin")) {
    return { ok: false, error: "Admin role required" };
  }
  return { ok: true };
}

export async function getSyncOutboxMetricsAction(): Promise<ActionResult<OutboxMetrics>> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { success: false, error: gate.error };

  try {
    const metrics = await getOutboxMetrics();
    return { success: true, data: metrics };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to read outbox metrics",
    };
  }
}

export async function requeueSyncDeadLetterAction(
  jobId: string
): Promise<ActionResult<{ requeued: boolean }>> {
  const gate = await requireAdminSession();
  if (!gate.ok) return { success: false, error: gate.error };

  if (!jobId || typeof jobId !== "string") {
    return { success: false, error: "jobId is required" };
  }

  try {
    const requeued = await requeueDeadLetter(jobId);
    return { success: true, data: { requeued } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to requeue job",
    };
  }
}
