// app/onramp/page.tsx
//
// Legacy route. The standalone Transak on-ramp page has been folded into
// the unified Exchange page (buy mode), which builds the Transak widget
// through the same server actions (app/actions/onramp.ts +
// app/lib/transak-service.ts). We keep the path alive as a server-side
// redirect so old links / bookmarks resolve to the new "Def" UI instead of
// rendering the deprecated dark design.
//
// Nothing on-ramp-related was removed; the /exchange page performs its own
// session check and redirects to /login if needed.
import { redirect } from "next/navigation";

export default function OnRampPage() {
  redirect("/exchange?mode=buy");
}
