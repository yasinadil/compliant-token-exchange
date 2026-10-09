// app/lib/checkout-audit.ts
// Per-request audit logging for the Checkout API. Every request to /api/checkout/*
// records exactly one durable row (success OR failure) in checkout_audit_log,
// including rejected attempts that never move a balance. See migration 025.
//
// This is separate from ledger_transactions (money) and admin_audit_log (admin
// dashboard actions). It stays local — it is NOT synced downstream.

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { adminDb } from "./db";
import { validateApiKey } from "./checkout-service";
import type { ResultSetHeader } from "mysql2";

export type CheckoutAuditAction =
  | "charge"
  | "refund"
  | "balance"
  | "get_charge"
  | "list_charges";

type CheckoutPermission = "charge" | "refund" | "balance";

/** Domain fields the handler fills in as it learns them. The wrapper reads this
 *  after the handler returns and writes a single audit row. */
export interface CheckoutAuditCtx {
  apiKeyId?: number | null;
  keyIdPresented?: string | null;
  userId?: string | null;
  amount?: string | null;
  currency?: string | null;
  idempotencyKey?: string | null;
  chargeId?: string | null;
  refundId?: string | null;
  errorMessage?: string | null;
}

function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) : s;
}

interface CheckoutAuditRow {
  requestId: string;
  apiKeyId: number | null;
  keyIdPresented: string | null;
  action: CheckoutAuditAction;
  httpMethod: string;
  userId: string | null;
  amount: string | null;
  currency: string | null;
  idempotencyKey: string | null;
  chargeId: string | null;
  refundId: string | null;
  statusCode: number;
  success: boolean;
  errorMessage: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  latencyMs: number | null;
}

/** Insert one audit row. Never throws — an audit failure must not break the API
 *  request, but it is logged loudly so the gap is visible in server logs. */
export async function logCheckoutRequest(row: CheckoutAuditRow): Promise<void> {
  try {
    await adminDb.execute<ResultSetHeader>(
      `INSERT INTO checkout_audit_log
         (request_id, api_key_id, key_id_presented, action, http_method,
          user_id, amount, currency, idempotency_key, charge_id, refund_id,
          status_code, success, error_message, ip_address, user_agent, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.requestId,
        row.apiKeyId,
        row.keyIdPresented,
        row.action,
        row.httpMethod,
        row.userId,
        row.amount,
        row.currency,
        row.idempotencyKey,
        row.chargeId,
        row.refundId,
        row.statusCode,
        row.success,
        row.errorMessage,
        row.ipAddress,
        row.userAgent,
        row.latencyMs,
      ]
    );
  } catch (err) {
    console.error("[Checkout] audit log write failed:", err);
  }
}

function extractIp(request: NextRequest): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return request.headers.get("x-real-ip");
}

/**
 * Wrap a checkout route handler so every return path is audited exactly once.
 * The handler receives a mutable ctx to record the domain fields it learns
 * (api key, user, amount, resulting charge/refund id, error message).
 */
export async function withCheckoutAudit(
  request: NextRequest,
  action: CheckoutAuditAction,
  handler: (ctx: CheckoutAuditCtx) => Promise<NextResponse>
): Promise<NextResponse> {
  const started = Date.now();
  const ip = extractIp(request);
  const userAgent = request.headers.get("user-agent");
  const ctx: CheckoutAuditCtx = {};

  let response: NextResponse;
  try {
    response = await handler(ctx);
  } catch (err) {
    console.error(`[Checkout] ${action} handler crashed:`, err);
    ctx.errorMessage = err instanceof Error ? err.message : "handler crashed";
    response = NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }

  void logCheckoutRequest({
    requestId: crypto.randomUUID(),
    action,
    httpMethod: request.method,
    statusCode: response.status,
    success: response.status < 400,
    ipAddress: clip(ip, 64),
    userAgent: clip(userAgent, 512),
    latencyMs: Date.now() - started,
    apiKeyId: ctx.apiKeyId ?? null,
    keyIdPresented: clip(ctx.keyIdPresented, 64),
    userId: clip(ctx.userId, 255),
    amount: ctx.amount ?? null,
    currency: clip(ctx.currency, 10),
    idempotencyKey: clip(ctx.idempotencyKey, 255),
    chargeId: clip(ctx.chargeId, 64),
    refundId: clip(ctx.refundId, 64),
    errorMessage: clip(ctx.errorMessage, 512),
  });

  return response;
}

/**
 * Shared auth for checkout routes. Records the presented key id + resolved
 * api_key_id (or the auth error) into ctx so a rejected request is still
 * audited with useful context.
 */
export async function authenticateCheckout(
  request: NextRequest,
  permission: CheckoutPermission,
  ctx: CheckoutAuditCtx
): Promise<{ ok: true; apiKeyId: number } | { ok: false; response: NextResponse }> {
  const apiKey = request.headers.get("x-api-key") || "";
  const apiSecret = request.headers.get("x-api-secret") || "";
  ctx.keyIdPresented = apiKey || null;

  if (!apiKey || !apiSecret) {
    ctx.errorMessage = "Missing X-API-Key or X-API-Secret header";
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 401 }),
    };
  }

  const result = await validateApiKey(apiKey, apiSecret, permission);
  if (!result.valid) {
    ctx.errorMessage = result.error;
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: result.error }, { status: 401 }),
    };
  }

  ctx.apiKeyId = result.apiKeyId;
  return { ok: true, apiKeyId: result.apiKeyId };
}
