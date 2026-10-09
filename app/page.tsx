// app/page.tsx
import { redirect } from "next/navigation";
import { getServerSession } from "@/app/lib/auth-service";
import { ensureWalletExists } from "@/app/lib/wallet-service";
import AppShell from "@/components/AppShell";
import Dashboard from "@/components/Dashboard";

export default async function Home() {
  // Get session (proxy.ts already handles token refresh)
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  // Ensure user has a wallet
  let wallet = null;
  try {
    wallet = await ensureWalletExists(session.userId);
  } catch (error) {
    console.error("Failed to ensure wallet exists:", error);
    // Don't block the page load, wallet can be created later
  }

  return (
    <AppShell>
      <Dashboard user={session} wallet={wallet} />
    </AppShell>
  );
}
