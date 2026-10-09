// app/cashout/page.tsx
//
// Legacy route. The old "Cash Out" UI has been folded into the unified
// Exchange page (sell mode). We keep the path alive as a server-side
// redirect so old links / bookmarks resolve to the new "Def" UI instead
// of rendering the deprecated dark design.
//
// All off-ramp/cash-out logic still lives in the Exchange component +
// server actions (app/actions/cashout.ts) — nothing was removed. The
// /exchange page performs its own session check and redirects to /login.
import { redirect } from "next/navigation";

export default function CashoutPage() {
  redirect("/exchange?mode=sell");
}
