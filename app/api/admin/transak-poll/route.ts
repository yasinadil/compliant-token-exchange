// app/api/admin/transak-poll/route.ts
// Internal ops endpoint: poll a Transak order and (POST) trigger the credit flow.
// Usage: GET|POST /api/admin/transak-poll?orderId=<transak-order-id>
//
// Auth: shared secret via `Authorization: Bearer <CRON_SECRET>` (same fail-closed
// pattern as app/api/cron/*). If CRON_SECRET is unset we deny everyone. This is
// an internal operator tool that drives on-ramp crediting and exposes order
// details — it must never be reachable unauthenticated, and it intentionally
// does NOT accept the partner-facing checkout API key (wrong trust domain).

import { NextRequest, NextResponse } from "next/server";
import {
  fetchTransakOrder,
  pollAndProcessTransakOrder,
} from "@/app/lib/transak-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const orderId = request.nextUrl.searchParams.get("orderId");

  if (!orderId) {
    return NextResponse.json({ error: "Missing orderId param" }, { status: 400 });
  }

  try {
    const order = await fetchTransakOrder(orderId);

    return NextResponse.json({
      status: order.status,
      fiatAmount: order.fiatAmount,
      fiatCurrency: order.fiatCurrency,
      cryptoAmount: order.cryptoAmount,
      cryptoCurrency: order.cryptoCurrency,
      network: order.network,
      walletAddress: order.walletAddress,
      transactionHash: order.transactionHash,
      partnerOrderId: order.partnerOrderId,
      completedAt: order.completedAt,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const orderId = request.nextUrl.searchParams.get("orderId");

  if (!orderId) {
    return NextResponse.json({ error: "Missing orderId param" }, { status: 400 });
  }

  try {
    const result = await pollAndProcessTransakOrder(orderId);
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
