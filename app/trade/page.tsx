// app/trade/page.tsx
//
// Legacy route. The old "Trade" UI has been folded into the unified
// Exchange page (buy mode). We keep the path alive as a server-side
// redirect so old links / bookmarks resolve to the new "Def" UI instead
// of rendering the deprecated dark design.
//
// All trading logic still lives in the Exchange component + server actions
// (app/actions/trade-orders.ts) — nothing was removed. The /exchange page
// performs its own session check and will redirect to /login if needed.
import { redirect } from "next/navigation";

export default function TradePage() {
  redirect("/exchange?mode=buy");
}
