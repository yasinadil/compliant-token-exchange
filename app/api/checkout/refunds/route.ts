// app/api/checkout/refunds/route.ts
// POST: Create a refund (full or partial credit back to user)

import { NextRequest, NextResponse } from "next/server";
import { createRefund } from "@/app/lib/checkout-service";
import { withCheckoutAudit, authenticateCheckout } from "@/app/lib/checkout-audit";

export async function POST(request: NextRequest) {
  return withCheckoutAudit(request, "refund", async (ctx) => {
    const auth = await authenticateCheckout(request, "refund", ctx);
    if (!auth.ok) return auth.response;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      ctx.errorMessage = "Invalid JSON body";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }

    const { charge_id, amount, reason, idempotency_key } = body as {
      charge_id?: string;
      amount?: string;
      reason?: string;
      idempotency_key?: string;
    };

    ctx.chargeId = typeof charge_id === "string" ? charge_id : null;
    ctx.amount = typeof amount === "string" ? amount : null;
    ctx.idempotencyKey = typeof idempotency_key === "string" ? idempotency_key : null;

    if (!charge_id || typeof charge_id !== "string") {
      ctx.errorMessage = "charge_id is required (the chg_ ID of the original charge)";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }
    if (!idempotency_key || typeof idempotency_key !== "string") {
      ctx.errorMessage = "idempotency_key is required (unique per refund attempt)";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }

    const result = await createRefund({
      apiKeyId: auth.apiKeyId,
      chargeId: charge_id,
      amount: typeof amount === "string" ? amount : undefined,
      reason: typeof reason === "string" ? reason : undefined,
      idempotencyKey: idempotency_key,
    });

    if (!result.success) {
      ctx.errorMessage = result.error;
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    ctx.refundId = result.refund.id;
    return NextResponse.json({ success: true, refund: result.refund });
  });
}
