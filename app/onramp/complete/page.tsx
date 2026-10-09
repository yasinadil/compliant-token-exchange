// app/onramp/complete/page.tsx
//
// Legacy route. The buy/on-ramp flow no longer uses a post-payment return
// page: the Transak buy widget shows its native success screen while the
// dApp tab polls the order status (see createOnRampWidgetUrl in
// app/lib/transak-service.ts — it intentionally sets no redirectURL). This
// path is kept only so any stale bookmark resolves to the Dashboard in the
// new "Def" UI instead of rendering the deprecated dark design.
import { redirect } from "next/navigation";

export default function OnRampCompletePage() {
  redirect("/");
}
