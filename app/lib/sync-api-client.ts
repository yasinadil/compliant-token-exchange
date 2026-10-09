// app/lib/sync-api-client.ts
// Thin REST client for the external MS SQL Server sync API. Sends the versioned
// envelope with an Idempotency-Key header, and classifies the response into
// success / retryable / fatal so the outbox worker knows whether to complete,
// retry with backoff, or dead-letter the job.

import "server-only";
import type { SyncEnvelope } from "./sync-outbox-service";

const BASE_URL = process.env.SYNC_API_BASE_URL || "";
const API_KEY = process.env.SYNC_API_KEY || "";
const API_KEY_HEADER = process.env.SYNC_API_KEY_HEADER || "X-Api-Key";
const REQUEST_TIMEOUT_MS = Number(process.env.SYNC_API_TIMEOUT_MS) || 15_000;

// Single idempotent upsert endpoint (overridable so the downstream dev can name
// it freely). The downstream proc MERGEs on the natural key, so insert vs update
// is the same operation — one endpoint is all we need. The intended operation is
// still carried in the envelope (`operation`) for the downstream's logging.
const UPSERT_PATH = process.env.SYNC_API_UPSERT_PATH || "/api/sync/upsert";

/** True once the downstream API is configured; the worker no-ops otherwise. */
export function isSyncApiConfigured(): boolean {
  return BASE_URL.length > 0;
}

export type SyncResultOutcome = "success" | "retryable" | "fatal";

export interface SyncResult {
  outcome: SyncResultOutcome;
  status?: number;
  remoteRef?: string | null;
  error?: string;
  /** Parsed from a 429 Retry-After header, in milliseconds. */
  retryAfterMs?: number;
}

/**
 * Deliver one envelope to the downstream API via the single upsert endpoint
 * (POST). The downstream MERGEs on the natural key, so this is idempotent for
 * both new and changed rows.
 * Status-code contract:
 *   200/201/409 -> success
 *   400/401/403/404/422 -> fatal (do not retry; dead-letter)
 *   429/5xx / network / timeout -> retryable
 */
export async function sendSyncJob(envelope: SyncEnvelope): Promise<SyncResult> {
  if (!isSyncApiConfigured()) {
    return { outcome: "retryable", error: "SYNC_API_BASE_URL not configured" };
  }

  const url = joinUrl(BASE_URL, UPSERT_PATH);
  const method = "POST";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": envelope.idempotency_key,
    };
    if (API_KEY) headers[API_KEY_HEADER] = API_KEY;

    res = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(envelope),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    // Network error / DNS / connection refused / timeout (abort) -> retryable.
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "retryable", error: `network: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }

  const status = res.status;

  // Success: created, ok, or a duplicate/conflict the downstream treats as done.
  if (status === 200 || status === 201 || status === 409) {
    let remoteRef: string | null = null;
    try {
      const body = (await res.json()) as { remote_ref?: string | null };
      remoteRef = body?.remote_ref ?? null;
    } catch {
      /* body optional / non-JSON — still a success */
    }
    return { outcome: "success", status, remoteRef };
  }

  const bodyText = await safeText(res);

  // Permanent / client errors: do not retry.
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return { outcome: "fatal", status, error: `HTTP ${status}: ${bodyText}` };
  }

  // Rate limited: honor Retry-After if present.
  if (status === 429) {
    return {
      outcome: "retryable",
      status,
      error: `HTTP 429: ${bodyText}`,
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    };
  }

  // 5xx and anything else transient -> retry.
  return { outcome: "retryable", status, error: `HTTP ${status}: ${bodyText}` };
}

// ============================================================================
// HELPERS
// ============================================================================

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}

/** Retry-After may be seconds (delta) or an HTTP date. Returns ms or undefined. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
