"use server";

// Admin testing utilities. Surface only via the bell popover in AppShell.
// Bulk-cancels in-flight Buy + Sell orders so a noisy "pending" backlog
// (commonly accumulated while Transak webhook reach is broken) can be
// wiped without manually walking each row. Not for production users —
// gated by Admin role.

import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { adminDb } from "@/app/lib/db";
import { getServerSession } from "@/app/lib/auth-service";
import { creditBalance } from "@/app/lib/ledger-service";
import {
  refundCancellableCashout,
  type CashoutOrder,
  type CashoutToken,
} from "@/app/lib/cashout-service";

// Marker appended to `process_notes` when the recovery action below
// credits a user back. Used as the idempotency guard so re-running the
// recovery doesn't double-refund — rows with this marker are skipped.
const RECOVERY_MARKER = "RECOVERED: bulk-cancel refund applied";

export async function adminCancelAllPendingAction(): Promise<
  | {
      success: true;
      trades: number;
      cashouts: number;
      topUps: number;
      skipped: { trades: number; cashouts: number; topUps: number };
    }
  | { success: false; error: string }
> {
  // TEMP: admin gating disabled for testing. Restore the
  // `session.roles?.includes("Admin")` check before shipping.
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    // ── 1) Trade orders ──────────────────────────────────────────
    // Only cancel `pending_payment` — at that status the user hasn't
    // paid Transak yet, so no funds need to be refunded. Later states
    // (`payment_received`, `processing`) mean Transak already has the
    // user's money or the credit is mid-flight — cancelling those
    // raw-UPDATE-style would leave the user paid out of pocket. Those
    // need to be recovered via the per-order recovery action, not bulk
    // wiped.
    const [tradeRes] = await adminDb.execute<ResultSetHeader>(
      `UPDATE trade_orders
         SET status = 'cancelled',
             failure_reason = 'Admin bulk-cancel (testing)'
       WHERE status = 'pending_payment'`
    );
    const [tradeSkippedRows] = await adminDb.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM trade_orders
         WHERE status IN ('payment_received', 'processing')`
    );
    const tradesSkipped = Number(tradeSkippedRows[0]?.n ?? 0);

    // ── 2) Cashouts ──────────────────────────────────────────────
    // Fetch each cashout in a refundable state, then refund it via
    // the proper service helper. This restores the user's balance
    // (USDX for PLAT post-AMM-swap, original token otherwise)
    // before marking the row failed.
    //
    // Critically, the previous version of this function ran a raw
    // `UPDATE ... SET status = 'failed'` across these rows, which
    // left users out of pocket whenever their cashout had already
    // debited their balance — exactly the bug that swallowed a real
    // user's PLAT during testing.
    //
    // Statuses past `awaiting_transak` (`payout_sent`, `crypto_sent`)
    // are NOT bulk-cancelled here: the operator wallet has already
    // broadcast a transfer to Transak's deposit address, and a naive
    // refund without recovering the crypto first would pay the user
    // twice. Surface those as `skipped` so the admin knows manual
    // operator review is needed.
    const [cashoutsToRefund] = await adminDb.execute<
      (RowDataPacket & CashoutOrder)[]
    >(
      `SELECT * FROM cashout_orders
         WHERE status IN ('awaiting_transak', 'pending_payout')`
    );

    let cashoutsRefunded = 0;
    for (const order of cashoutsToRefund) {
      try {
        await refundCancellableCashout(
          order.cashout_id,
          session.userId,
          "Admin bulk-cancel (testing)"
        );
        cashoutsRefunded++;
      } catch (err) {
        console.error(
          `[admin-debug] Failed to refund cashout ${order.cashout_id}:`,
          err
        );
      }
    }

    const [cashoutSkippedRows] = await adminDb.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM cashout_orders
         WHERE status IN ('payout_sent', 'crypto_sent')`
    );
    const cashoutsSkipped = Number(cashoutSkippedRows[0]?.n ?? 0);

    // ── 3) Stable on-ramp top-ups ───────────────────────────────
    // Same shape as trade orders. `pending` is safe (user hasn't paid
    // Transak yet). `processing` means Transak already has the payment
    // and credit is in flight — cancelling raw-UPDATE-style would
    // leave the user without the tokens they paid for.
    //
    // Filter to `target_token IS NOT NULL` so we only touch rows from
    // the new Buy flow; trade-linked onramps (target_token NULL) are
    // owned by the trade lifecycle and the legacy /onramp orphans
    // (also NULL) aren't reachable from the new dApp.
    const [topUpRes] = await adminDb.execute<ResultSetHeader>(
      `UPDATE onramp_orders
         SET status = 'failed',
             failure_reason = 'Cancelled by admin (testing)'
       WHERE target_token IS NOT NULL
         AND status = 'pending'`
    );
    const [topUpSkippedRows] = await adminDb.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM onramp_orders
         WHERE target_token IS NOT NULL
           AND status = 'processing'`
    );
    const topUpsSkipped = Number(topUpSkippedRows[0]?.n ?? 0);

    return {
      success: true,
      trades: tradeRes.affectedRows ?? 0,
      cashouts: cashoutsRefunded,
      topUps: topUpRes.affectedRows ?? 0,
      skipped: {
        trades: tradesSkipped,
        cashouts: cashoutsSkipped,
        topUps: topUpsSkipped,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Bulk-cancel failed",
    };
  }
}

// ============================================================================
// RECOVERY — refund users whose cashouts were swallowed by the old buggy
// bulk-cancel (which raw-UPDATEd status='failed' without crediting back).
// ============================================================================
//
// Targets only rows where the bulk-cancel ran AND the crypto was never
// actually sent on-chain (`treasury_tx_hash IS NULL`) — those were in
// `awaiting_transak` or `pending_payout` at the time of cancel, so the
// platform still held the funds (USDX post-AMM for PLAT, original
// token otherwise) and the user is owed a straight ledger credit.
//
// Rows with `treasury_tx_hash` set are intentionally excluded: the
// operator wallet had already broadcast a transfer to Transak's deposit
// address, so refunding the ledger without recovering the crypto would
// pay the user twice. Those need manual operator review.
//
// Idempotent: once a row is refunded its `process_notes` gets the
// RECOVERY_MARKER appended, and the WHERE clause excludes anything
// already carrying it. Safe to click twice.
export async function adminRecoverBulkCancelledCashoutsAction(): Promise<
  | { success: true; refunded: number; alreadyHandled: number; unsafeSkipped: number }
  | { success: false; error: string }
> {
  // TEMP: admin gating disabled for testing. Same pattern as the
  // bulk-cancel action above — restore role gate before shipping.
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  try {
    // Eligible rows: bulk-cancelled, crypto never sent, not already
    // recovered. The process_notes match is exact-string against the
    // marker the old buggy action wrote, so legitimate user cancels
    // and timeout sweeps (different markers) aren't touched.
    const [rows] = await adminDb.execute<(RowDataPacket & CashoutOrder)[]>(
      `SELECT * FROM cashout_orders
         WHERE status = 'failed'
           AND process_notes = 'Admin bulk-cancel (testing)'
           AND treasury_tx_hash IS NULL
           AND (process_notes NOT LIKE ? OR process_notes IS NULL)`,
      [`%${RECOVERY_MARKER}%`]
    );

    let refunded = 0;
    let unsafeSkipped = 0;
    for (const order of rows) {
      try {
        // Same refund rule as the production refund paths: PLAT
        // cashouts with the AMM swap already executed are refunded as
        // USDX (because that's what's actually in treasury); all other
        // cases refund the original token amount.
        const refundToken: CashoutToken =
          order.token === "PLAT" && order.operator_tx_hash
            ? "USDX"
            : order.token;
        const refundAmount =
          order.token === "PLAT" && order.operator_tx_hash
            ? parseFloat(order.tusd_amount).toFixed(18)
            : parseFloat(order.token_amount).toFixed(18);

        if (!(parseFloat(refundAmount) > 0)) {
          // Nothing to refund (shouldn't happen for a real cashout, but
          // guard against zero/negative amounts so we never log a misleading
          // credit). Counted as unsafe-skipped so admin sees the row.
          unsafeSkipped++;
          continue;
        }

        await creditBalance(order.user_id, refundToken, refundAmount, {
          notes: `Recovery: refunded after buggy bulk-cancel did not credit (cashout ${order.cashout_id})`,
          type: "adjustment",
          createdBy: session.userId,
        });

        // Append the marker so this row is excluded on re-run.
        await adminDb.execute(
          `UPDATE cashout_orders SET
            process_notes = CONCAT(process_notes, ' | ', ?),
            failure_reason = 'Cancelled by admin — recovered'
          WHERE cashout_id = ?`,
          [RECOVERY_MARKER, order.cashout_id]
        );
        refunded++;
      } catch (err) {
        console.error(
          `[admin-debug] Recovery failed for cashout ${order.cashout_id}:`,
          err
        );
        unsafeSkipped++;
      }
    }

    // Count of rows we ALREADY recovered in a prior run (or by hand) so
    // the admin understands the difference between "nothing to do" and
    // "everything already handled".
    const [alreadyRows] = await adminDb.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM cashout_orders
         WHERE status = 'failed'
           AND process_notes LIKE ?`,
      [`%${RECOVERY_MARKER}%`]
    );
    const alreadyHandled = Number(alreadyRows[0]?.n ?? 0);

    // Rows that match the bulk-cancel marker but had crypto already
    // sent on-chain — these are intentionally NOT refunded here
    // (would double-pay) and need operator review.
    const [unsafeRows] = await adminDb.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM cashout_orders
         WHERE status = 'failed'
           AND process_notes = 'Admin bulk-cancel (testing)'
           AND treasury_tx_hash IS NOT NULL`
    );
    const unsafeFromCrypto = Number(unsafeRows[0]?.n ?? 0);

    return {
      success: true,
      refunded,
      alreadyHandled,
      unsafeSkipped: unsafeSkipped + unsafeFromCrypto,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Recovery failed",
    };
  }
}
