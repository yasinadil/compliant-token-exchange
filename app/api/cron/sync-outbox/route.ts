// app/api/cron/sync-outbox/route.ts
// Scheduled worker for the transactional outbox: drains sync_outbox by claiming
// due jobs and delivering them to the external MS SQL Server sync API, applying
// exponential-backoff retries and dead-lettering. Intended to be driven by a
// cron every ~30-60s in production (VM crontab, Azure timer, etc.).
//
// Auth mirrors app/api/cron/reconcile/route.ts: a shared secret via
// `Authorization: Bearer <CRON_SECRET>` OR Vercel's `x-vercel-cron` header.
// If CRON_SECRET is unset we fail closed.

import { NextRequest, NextResponse } from "next/server";
import { runSyncOutboxSweep } from "@/app/lib/sync-outbox-runner";
import { getOutboxMetrics, pruneCompleted } from "@/app/lib/sync-outbox-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") || "";
  if (header === `Bearer ${secret}`) return true;

  if (request.headers.get("x-vercel-cron") === "1") {
    const altHeader = request.headers.get("x-cron-secret");
    return altHeader === secret;
  }

  return false;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl;
  const batchSize = Number(url.searchParams.get("batchSize")) || undefined;
  const doPrune = url.searchParams.get("prune") === "1";

  try {
    const sweep = await runSyncOutboxSweep({ batchSize });

    // Optional retention pass (drive from a separate, less frequent cron).
    let pruned: number | undefined;
    if (doPrune) {
      pruned = await pruneCompleted();
    }

    // Always attach metrics so a scrape of this endpoint doubles as a probe.
    const metrics = await getOutboxMetrics();

    return NextResponse.json({ ok: true, sweep, pruned, metrics });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[SyncOutbox] Top-level sweep failure:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
