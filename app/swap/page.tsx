// app/swap/page.tsx
//
// Legacy route. The old "Fiat Swap" UI has been folded into the unified
// Exchange page (swap mode). We keep the path alive as a server-side
// redirect so old links / bookmarks resolve to the new "Def" UI instead
// of rendering the deprecated dark design.
//
// All swap logic still lives in the Exchange component + server actions
// (app/actions/swap.ts) — nothing was removed. The /exchange page performs
// its own session check and redirects to /login if needed.
import { redirect } from "next/navigation";

export default function SwapPage() {
  redirect("/exchange?mode=swap");
}
