// app/api/checkout/charges/[id]/route.ts
// GET: Retrieve a single charge by its chg_ ID

import { NextRequest, NextResponse } from "next/server";
import { getCharge } from "@/app/lib/checkout-service";
import { withCheckoutAudit, authenticateCheckout } from "@/app/lib/checkout-audit";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withCheckoutAudit(request, "get_charge", async (ctx) => {
    const auth = await authenticateCheckout(request, "balance", ctx);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    ctx.chargeId = id;

    const charge = await getCharge(id, auth.apiKeyId);

    if (!charge) {
      ctx.errorMessage = "Charge not found";
      return NextResponse.json({ success: false, error: "Charge not found" }, { status: 404 });
    }

    ctx.userId = charge.user_id;
    return NextResponse.json({ success: true, charge });
  });
}
