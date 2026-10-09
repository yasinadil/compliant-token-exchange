// app/api/cron/reconcile/route.ts
// Scheduled reconciler: catches up any on-ramp / cash-out / trade orders
// that may have missed their webhook or stalled mid-execution (Azure MySQL
// down, Transak webhook backlog, process kill between chain tx and DB
// write, ...). Intended to be driven by a cron (Vercel Cron, Azure Function
// timer, GitHub Actions scheduled workflow, …) every few minutes in
// production.
//
// Auth: the route requires a shared secret via `Authorization: Bearer <CRON_SECRET>`
// OR Vercel's own `x-vercel-cron: 1` header. If `CRON_SECRET` is unset we
// deliberately fail closed.

import { NextRequest, NextResponse } from "next/server";
import { db, withMysqlRetry } from "@/app/lib/db";
import {
  pollAndProcessTransakOrder,
  fetchTransakOrderByPartnerOrderId,
  linkTransakOrder,
} from "@/app/lib/transak-service";
import {
  reconcileStaleAwaitingOrders,
  expireInFlightOrders,
} from "@/app/lib/cashout-service";
import {
  findStuckExecutingOrders,
  recoverStuckExecutingOrder,
} from "@/app/lib/trade-order-service";
import type { RowDataPacket } from "mysql2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LOOKBACK_HOURS = 48;
const DEFAULT_MAX_ORDERS = 50;
const DEFAULT_STUCK_TRADE_MIN_AGE_MINUTES = 10;

interface OnrampRow extends RowDataPacket {
  order_id: string;
  user_id: string;
  partner_order_id: string;
  transak_order_id: string | null;
  status: string;
  created_at: string;
}

interface CashoutRow extends RowDataPacket {
  user_id: string;
}

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

async function reconcileOnrampOrders(
  lookbackHours: number,
  maxOrders: number
): Promise<{
  scanned: number;
  resolved: number;
  failures: Array<{ orderId: string; error: string }>;
}> {
  const [rows] = await withMysqlRetry(() =>
    db.query<OnrampRow[]>(
      `SELECT order_id, user_id, partner_order_id, transak_order_id, status, created_at
         FROM onramp_orders
        WHERE status IN ('pending', 'processing', 'awaiting_transak')
          AND created_at >= (NOW() - INTERVAL ? HOUR)
        ORDER BY created_at ASC
        LIMIT ?`,
      [lookbackHours, maxOrders]
    )
  );

  let resolved = 0;
  const failures: Array<{ orderId: string; error: string }> = [];

  for (const row of rows) {
    try {
      let transakOrderId = row.transak_order_id;

      if (!transakOrderId && row.partner_order_id) {
        const transakOrder = await fetchTransakOrderByPartnerOrderId(
          row.partner_order_id
        );
        if (transakOrder?._id) {
          await linkTransakOrder(row.partner_order_id, transakOrder._id);
          transakOrderId = transakOrder._id;
        }
      }

      if (!transakOrderId) {
        continue;
      }

      const result = await pollAndProcessTransakOrder(transakOrderId);
      if (result.credited) resolved += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(
        `[Reconcile] Failed on-ramp order ${row.order_id}:`,
        msg
      );
      failures.push({ orderId: row.order_id, error: msg });
    }
  }

  return { scanned: rows.length, resolved, failures };
}

async function reconcileCashoutOrders(): Promise<{
  users: number;
  reconciled: number;
  failures: Array<{ userId: string; error: string }>;
}> {
  const [rows] = await withMysqlRetry(() =>
    db.query<CashoutRow[]>(
      `SELECT DISTINCT user_id
         FROM cashout_orders
        WHERE status IN ('awaiting_transak', 'crypto_sent', 'processing', 'pending_payout')`
    )
  );

  let reconciled = 0;
  const failures: Array<{ userId: string; error: string }> = [];

  for (const row of rows) {
    try {
      const count = await reconcileStaleAwaitingOrders(row.user_id);
      reconciled += count;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(
        `[Reconcile] Failed cashout reconcile for user ${row.user_id}:`,
        msg
      );
      failures.push({ userId: row.user_id, error: msg });
    }
  }

  return { users: rows.length, reconciled, failures };
}

/**
 * Finalise trade orders that got stuck in `executing`.
 *
 * Two failure modes exist:
 *   - Ledger credit never landed but the on-chain swap did (chain tx hash
 *     present). Safe to re-drive the credit via idempotency key.
 *   - No on-chain tx hash recorded. We can't auto-decide whether chain ran;
 *     surface these for operator review and let the runbook resolve them.
 */
async function reconcileStuckTradeOrders(
  minAgeMinutes: number,
  maxOrders: number
): Promise<{
  scanned: number;
  completed: number;
  needsReview: Array<{ orderId: string; reason: string }>;
  failures: Array<{ orderId: string; error: string }>;
}> {
  const rows = await withMysqlRetry(() =>
    findStuckExecutingOrders(minAgeMinutes, maxOrders)
  );

  let completed = 0;
  const needsReview: Array<{ orderId: string; reason: string }> = [];
  const failures: Array<{ orderId: string; error: string }> = [];

  for (const row of rows) {
    try {
      const result = await recoverStuckExecutingOrder(row.order_id);
      if (result.outcome === "completed") {
        completed += 1;
      } else if (result.outcome === "needs_manual_review") {
        needsReview.push({ orderId: row.order_id, reason: result.reason });
        console.warn(
          `[Reconcile] Trade order ${row.order_id} needs manual review: ${result.reason}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(
        `[Reconcile] Failed trade order ${row.order_id}:`,
        msg
      );
      failures.push({ orderId: row.order_id, error: msg });
    }
  }

  return { scanned: rows.length, completed, needsReview, failures };
}

async function runReconciliation(
  lookbackHours: number,
  maxOrders: number,
  stuckMinAgeMinutes: number
) {
  const started = Date.now();
  // 2-hour hard timeout sweep first so the downstream reconciles don't
  // re-process orders that should have been closed already.
  const expired = await expireInFlightOrders().catch((err) => {
    console.error("[Reconcile] expireInFlightOrders failed:", err);
    return { tradesCancelled: 0, cashoutsRefunded: 0, topUpsCancelled: 0 };
  });
  const onramp = await reconcileOnrampOrders(lookbackHours, maxOrders);
  const cashout = await reconcileCashoutOrders();
  const trades = await reconcileStuckTradeOrders(
    stuckMinAgeMinutes,
    maxOrders
  );
  const elapsedMs = Date.now() - started;

  return {
    ok: true,
    elapsedMs,
    lookbackHours,
    maxOrders,
    stuckMinAgeMinutes,
    expired,
    onramp,
    cashout,
    trades,
  };
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl;
  const lookbackHours =
    Number(url.searchParams.get("lookbackHours")) || DEFAULT_LOOKBACK_HOURS;
  const maxOrders =
    Number(url.searchParams.get("maxOrders")) || DEFAULT_MAX_ORDERS;
  const stuckMinAgeMinutes =
    Number(url.searchParams.get("stuckMinAgeMinutes")) ||
    DEFAULT_STUCK_TRADE_MIN_AGE_MINUTES;

  try {
    const result = await runReconciliation(
      lookbackHours,
      maxOrders,
      stuckMinAgeMinutes
    );
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[Reconcile] Top-level failure:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const POST = GET;
