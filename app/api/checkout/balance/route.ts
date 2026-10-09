// app/api/checkout/balance/route.ts
// GET: Check a user's available balance

import { NextRequest, NextResponse } from "next/server";
import { getCheckoutBalance } from "@/app/lib/checkout-service";
import { withCheckoutAudit, authenticateCheckout } from "@/app/lib/checkout-audit";

export async function GET(request: NextRequest) {
  return withCheckoutAudit(request, "balance", async (ctx) => {
    const auth = await authenticateCheckout(request, "balance", ctx);
    if (!auth.ok) return auth.response;

    const url = request.nextUrl;
    const userId = url.searchParams.get("user_id");
    const currency = url.searchParams.get("currency") || "PLAT";

    ctx.userId = userId;
    ctx.currency = currency.toUpperCase();

    if (!userId) {
      ctx.errorMessage = "user_id query parameter is required";
      return NextResponse.json({ success: false, error: ctx.errorMessage }, { status: 400 });
    }

    try {
      const balance = await getCheckoutBalance(userId, currency.toUpperCase());
      return NextResponse.json({ success: true, ...balance });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal server error";
      ctx.errorMessage = msg;
      if (msg.includes("Unsupported currency")) {
        return NextResponse.json({ success: false, error: msg }, { status: 400 });
      }
      console.error("[Checkout] GET /balance error:", error);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
}
