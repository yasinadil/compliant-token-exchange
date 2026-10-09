// app/staking/page.tsx
//
// Staking page — new "Def" UI. AppShell hosts the redesigned Staking
// component, which keeps every existing Web3 server action wired up
// (stake / unstake / claim / emergency-withdraw / pool info / history).

import { redirect } from "next/navigation";
import { getServerSession } from "@/app/lib/auth-service";
import { ensureWalletExists } from "@/app/lib/wallet-service";
import AppShell from "@/components/AppShell";
import Staking from "@/components/Staking";

export const dynamic = "force-dynamic";

export default async function StakingPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?callbackUrl=%2Fstaking");

  // Wallet bootstrap is best-effort — same pattern as Dashboard / Exchange.
  try {
    await ensureWalletExists(session.userId);
  } catch (error) {
    console.error("[staking] wallet bootstrap failed:", error);
  }

  return (
    <AppShell>
      <Staking />
    </AppShell>
  );
}
