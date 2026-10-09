// app/api/checkout/charges/route.ts
// POST: Create a charge (debit user balance)
// GET:  List charges (filtered by user_id, reference)

import { NextRequest, NextResponse } from "next/server";
import { createCharge, listCharges } from "@/app/lib/checkout-service";
import { withCheckoutAudit, authenticateCheckout } from "@/app/lib/checkout-audit";

export async function POST(request: NextRequest) {
  return withCheckoutAudit(request, "charge", async (ctx) => {
    const auth = await authenticateCheckout(request, "charge", ctx);
    if (!auth.ok) return auth.response;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      ctx.errorMessage = "Invalid JSON body";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }

    const { user_id, amount, currency, description, reference, idempotency_key } = body as {
      user_id?: string;
      amount?: string;
      currency?: string;
      description?: string;
      reference?: string;
      idempotency_key?: string;
    };

    ctx.userId = typeof user_id === "string" ? user_id : null;
    ctx.amount = typeof amount === "string" ? amount : null;
    ctx.currency = typeof currency === "string" ? currency.toUpperCase() : null;
    ctx.idempotencyKey = typeof idempotency_key === "string" ? idempotency_key : null;

    if (!user_id || typeof user_id !== "string") {
      ctx.errorMessage = "user_id is required (string)";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }
    if (!amount || typeof amount !== "string") {
      ctx.errorMessage = 'amount is required (string, e.g. "25.50")';
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }
    if (!currency || typeof currency !== "string") {
      ctx.errorMessage = 'currency is required (string, e.g. "PLAT")';
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }
    if (!reference || typeof reference !== "string") {
      ctx.errorMessage = "reference is required (your order ID)";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }
    if (!idempotency_key || typeof idempotency_key !== "string") {
      ctx.errorMessage = "idempotency_key is required (unique per charge attempt)";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }

    const result = await createCharge({
      apiKeyId: auth.apiKeyId,
      userId: user_id,
      amount,
      currency: currency.toUpperCase(),
      description: typeof description === "string" ? description : undefined,
      reference,
      idempotencyKey: idempotency_key,
    });

    if (!result.success) {
      ctx.errorMessage = result.error;
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    ctx.chargeId = result.charge.id;
    return NextResponse.json({ success: true, charge: result.charge });
  });
}

export async function GET(request: NextRequest) {
  return withCheckoutAudit(request, "list_charges", async (ctx) => {
    const auth = await authenticateCheckout(request, "balance", ctx);
    if (!auth.ok) return auth.response;

    const url = request.nextUrl;
    const userId = url.searchParams.get("user_id") || undefined;
    const reference = url.searchParams.get("reference") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    ctx.userId = userId ?? null;

    const charges = await listCharges({
      apiKeyId: auth.apiKeyId,
      userId,
      reference,
      limit,
      offset,
    });

    return NextResponse.json({ success: true, charges });
  });
}
