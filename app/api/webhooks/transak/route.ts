// app/api/webhooks/transak/route.ts
// Webhook endpoint for Transak on-ramp events

import { NextRequest, NextResponse } from "next/server";
import { db, isTransientDatabaseError, withMysqlRetry } from "@/app/lib/db";
import {
  verifyWebhookSignature,
  decodeAndVerifyWebhookJwt,
  isJwtWebhookEnvelope,
  processTransakWebhook,
  type TransakWebhookPayload,
} from "@/app/lib/transak-service";
import { processCashoutTransakWebhook } from "@/app/lib/cashout-service";
import type { ResultSetHeader } from "mysql2";

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================
//
// Response policy:
//   - 401 Unauthorized for signature failures (Transak will stop retrying).
//   - 200 OK when the webhook was persisted / processed, including benign
//     "logic" errors (unknown order id, bad status map). These SHOULD NOT
//     be retried — they are not going to succeed on a retry.
//   - 503 Service Unavailable when a transient DB error prevented us from
//     durably recording or processing the event. Transak's retry policy
//     will redeliver on 5xx, giving us an automatic buffer while MySQL
//     is recovering.
//
// The goal is: "never silently drop a real money event while the database
// is unhealthy" — the previous behaviour was to swallow the error and
// return 200, which caused events to vanish during outages.
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let eventId = "unknown";
  let transakOrderId = "unknown";
  let rawPayload = "";

  try {
    rawPayload = await request.text();

    const legacySignature = request.headers.get("x-transak-signature") || "";
    const ipAddress =
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown";

    // ── SIGNATURE VERIFICATION ──
    // Transak's current docs deliver the webhook as a signed JWT in the
    // top-level `data` field, verified with the Partner Access Token
    // (see https://docs.transak.com/guides/how-to-decrypt-webhook-payload).
    // We prefer that path and fall back to the legacy HMAC-signed body
    // format so partner accounts mid-migration keep working.
    let payload: TransakWebhookPayload | null = null;
    let verificationMethod: "jwt" | "hmac" | "none" = "none";
    let signatureForLog: string | null = null;

    if (isJwtWebhookEnvelope(rawPayload)) {
      payload = await decodeAndVerifyWebhookJwt(rawPayload);
      verificationMethod = "jwt";
      signatureForLog = null; // JWT carries its own signature inline
    } else {
      // Legacy HMAC path — kept purely as a bridge for older webhook configs.
      signatureForLog = legacySignature;
      if (verifyWebhookSignature(rawPayload, legacySignature)) {
        try {
          payload = JSON.parse(rawPayload) as TransakWebhookPayload;
          verificationMethod = "hmac";
        } catch (parseErr) {
          console.error("[Transak Webhook] Legacy payload parse failed:", parseErr);
          payload = null;
        }
      }
    }

    if (!payload) {
      console.error(
        `[Transak Webhook] Signature/payload verification failed (method=${verificationMethod})`
      );

      // Best-effort log (do not fail the 401 if logging fails).
      try {
        await logWebhook({
          eventId: "invalid-signature",
          transakOrderId: null,
          rawPayload,
          processed: false,
          processResult: "Invalid signature",
          errorMessage: `Signature verification failed (method=${verificationMethod})`,
          signature: signatureForLog,
          signatureValid: false,
          ipAddress,
        });
      } catch (logErr) {
        console.error("[Transak Webhook] Failed to log invalid signature:", logErr);
      }

      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    eventId = payload.eventID || "unknown";
    transakOrderId = payload.webhookData?.id || "unknown";

    console.log(
      `[Transak Webhook] Verified via ${verificationMethod.toUpperCase()} (event ${eventId})`
    );

    console.log(`[Transak Webhook] Received event: ${eventId}`);
    console.log(`[Transak Webhook] Order ID: ${transakOrderId}`);
    console.log(`[Transak Webhook] Status: ${payload.webhookData?.status}`);

    // ── DURABILITY GATE ──
    // Persist the raw payload FIRST so we can always reprocess from the DB.
    // If this fails and the DB is unhealthy, return 5xx so Transak retries.
    let logId: number;
    try {
      logId = await logWebhook({
        eventId,
        transakOrderId,
        rawPayload,
        processed: false,
        processResult: null,
        errorMessage: null,
        signature: signatureForLog,
        signatureValid: true,
        ipAddress,
      });
    } catch (logError) {
      if (isTransientDatabaseError(logError)) {
        console.error(
          `[Transak Webhook] DB unavailable while logging event ${eventId} — returning 503 so Transak retries.`,
          logError
        );
        return NextResponse.json(
          {
            success: false,
            retry: true,
            error: "Database temporarily unavailable. Please retry.",
            eventId,
          },
          { status: 503 }
        );
      }
      throw logError;
    }

    // Off-ramp (SELL) cashout_orders first — partner id is our cashout_id (64-char hex)
    const cashoutResult = await processCashoutTransakWebhook(payload);
    const result = cashoutResult.handled
      ? { success: cashoutResult.success, message: cashoutResult.message }
      : await processTransakWebhook(payload);

    // Best-effort log update; do not 5xx if only this update fails because
    // the business action already committed.
    try {
      await updateWebhookLog(logId, {
        processed: true,
        processResult: result.message,
      });
    } catch (updateErr) {
      console.error(
        "[Transak Webhook] Failed to update webhook log (non-fatal):",
        updateErr
      );
    }

    console.log(
      `[Transak Webhook] Processed in ${Date.now() - startTime}ms: ${result.message}`
    );

    return NextResponse.json({
      success: true,
      message: result.message,
      eventId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const transient = isTransientDatabaseError(error);
    console.error(
      `[Transak Webhook] ${transient ? "TRANSIENT" : "FATAL"} error processing event ${eventId}:`,
      errorMessage
    );

    // Best-effort record of the failure. If THIS also fails, we have already
    // returned upstream that we were unable to durably record the event, so
    // Transak's retries are the backstop.
    try {
      await logWebhook({
        eventId,
        transakOrderId,
        rawPayload,
        processed: false,
        processResult: "Error",
        errorMessage,
        signature: null,
        signatureValid: null,
        ipAddress: request.headers.get("x-forwarded-for") || "unknown",
      });
    } catch (logError) {
      console.error("[Transak Webhook] Failed to log error:", logError);
    }

    if (transient) {
      return NextResponse.json(
        {
          success: false,
          retry: true,
          error: "Transient downstream failure; please retry.",
          eventId,
        },
        { status: 503 }
      );
    }

    // Non-transient (logic) error. Retrying won't help — return 200 with
    // success:false so Transak moves on. The payload is already in the
    // onramp_webhook_logs table, so ops can investigate / replay manually.
    return NextResponse.json({
      success: false,
      error: errorMessage,
      eventId,
    });
  }
}

// ============================================================================
// WEBHOOK LOGGING
// ============================================================================

interface WebhookLogData {
  eventId: string;
  transakOrderId: string | null;
  rawPayload: string;
  processed: boolean;
  processResult: string | null;
  errorMessage: string | null;
  signature: string | null;
  signatureValid: boolean | null;
  ipAddress: string;
}

async function logWebhook(data: WebhookLogData): Promise<number> {
  // Retry transient Azure MySQL blips before bubbling up as 503.
  return withMysqlRetry(async () => {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO onramp_webhook_logs (
        event_id, transak_order_id, raw_payload, processed,
        process_result, error_message, signature, signature_valid, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.eventId,
        data.transakOrderId,
        data.rawPayload,
        data.processed,
        data.processResult,
        data.errorMessage,
        data.signature,
        data.signatureValid,
        data.ipAddress,
      ]
    );

    return result.insertId;
  });
}

async function updateWebhookLog(
  logId: number,
  data: { processed: boolean; processResult: string }
): Promise<void> {
  await withMysqlRetry(async () => {
    await db.execute(
      `UPDATE onramp_webhook_logs
       SET processed = ?, process_result = ?, processed_at = NOW()
       WHERE id = ?`,
      [data.processed, data.processResult, logId]
    );
  });
}

// ============================================================================
// VERIFICATION ENDPOINT (for Transak setup)
// ============================================================================

export async function GET() {
  // Transak may ping this endpoint to verify it's reachable
  return NextResponse.json({
    status: "ok",
    service: "exchange-onramp-webhook",
    timestamp: new Date().toISOString(),
  });
}
