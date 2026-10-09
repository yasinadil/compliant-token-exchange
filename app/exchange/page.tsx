// app/exchange/page.tsx
//
// Unified Exchange page — replaces the legacy Trade, Cash Out, and Fiat
// Swap routes with a single shell that exposes three internal modes:
//
//   • buy   → fiat → token   (preserves on-ramp / Transak widget logic)
//   • sell  → token → fiat   (preserves off-ramp / cash-out logic)
//   • swap  → token ↔ token  (preserves stablecoin swap logic)
//
// Internal mode names match `?mode=buy|sell|swap` in the URL so other
// surfaces (e.g. Dashboard quick actions) can deep-link to a tab.

import { redirect } from "next/navigation";
import { getServerSession } from "@/app/lib/auth-service";
import { ensureWalletExists } from "@/app/lib/wallet-service";
import AppShell from "@/components/AppShell";
import Exchange, { type ExchangeMode } from "@/components/Exchange";

interface ExchangePageProps {
  searchParams: Promise<{ mode?: string; token?: string; amount?: string }>;
}

const VALID_MODES: ExchangeMode[] = ["buy", "sell", "swap"];

export default async function ExchangePage({ searchParams }: ExchangePageProps) {
  const session = await getServerSession();
  if (!session) redirect("/login?callbackUrl=%2Fexchange");

  // Wallet bootstrap is best-effort — same pattern as the Dashboard.
  try {
    await ensureWalletExists(session.userId);
  } catch (error) {
    console.error("[exchange] wallet bootstrap failed:", error);
  }

  const params = await searchParams;
  const initialMode: ExchangeMode = VALID_MODES.includes(params.mode as ExchangeMode)
    ? (params.mode as ExchangeMode)
    : "buy";

  return (
    <AppShell>
      <Exchange initialMode={initialMode} />
    </AppShell>
  );
}
