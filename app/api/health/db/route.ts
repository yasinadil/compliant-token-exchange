// app/api/health/db/route.ts
// Lightweight database health probe. Returns 200 when MySQL is reachable
// and the circuit breaker is closed, otherwise 503. Safe to poll from the
// UI to show a maintenance banner during an Azure MySQL outage.

import { NextResponse } from "next/server";
import { pingDatabase } from "@/app/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const status = await pingDatabase();
  return NextResponse.json(
    {
      ok: status.ok,
      circuitOpen: status.circuitOpen,
      error: status.error ?? null,
      timestamp: new Date().toISOString(),
    },
    { status: status.ok ? 200 : 503 }
  );
}
