// app/admin/page.tsx
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getServerSession } from "@/app/lib/auth-service";
import { isAdminRole } from "@/app/lib/swap-security";
import Web3Provider from "@/app/context/Web3Provider";
import AdminPanel from "@/components/AdminPanel";
import AMMAdminPanel from "@/components/AMMAdminPanel";
import AdminPageClient from "@/components/AdminPageClient";
import ConnectButton from "@/components/ConnectButton";
import Link from "next/link";

export default async function AdminPage() {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  if (!isAdminRole(session.roles)) {
    redirect("/");
  }

  const headersList = await headers();
  const cookies = headersList.get("cookie");

  return (
    <Web3Provider cookies={cookies}>
      <div className="min-h-screen bg-[var(--ex-bg)]">
        {/* Header */}
        <header className="border-b border-[var(--ex-border)] bg-white/80 backdrop-blur-xl sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3 group">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/25 group-hover:shadow-blue-500/40 transition-shadow"
                style={{
                  background:
                    "linear-gradient(180deg, #CDEBF9 0%, #3E7A9D 47.6%, #070E12 100%)",
                }}
              >
                <span
                  aria-hidden
                  className="block h-5 w-6 bg-white"
                  style={{
                    WebkitMaskImage: 'url("/SideBar/18Logo.svg")',
                    maskImage: 'url("/SideBar/18Logo.svg")',
                    WebkitMaskPosition: "center",
                    maskPosition: "center",
                    WebkitMaskRepeat: "no-repeat",
                    maskRepeat: "no-repeat",
                    WebkitMaskSize: "contain",
                    maskSize: "contain",
                  }}
                />
              </div>
              <span className="text-xl font-bold text-[var(--ex-text)]">Admin Panel</span>
            </Link>
            <nav className="flex items-center gap-4">
              <Link
                href="/"
                className="px-4 py-2 text-sm text-[var(--ex-text-muted)] hover:text-[var(--ex-text)] transition-colors hidden sm:block"
              >
                Dashboard
              </Link>
              {/*<Link
                href="/trade"
                className="px-4 py-2 text-[var(--ex-text-muted)] hover:text-[var(--ex-text)] transition-colors hidden sm:block"
              >
                Trade
              </Link>*/}
              <ConnectButton />
              <span className="px-3 py-1 text-sm font-medium text-blue-700 bg-blue-500/10 rounded-full border border-blue-400/30">
                ADMIN
              </span>
            </nav>
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-[var(--ex-text)] mb-2">Management Console</h1>
            <p className="text-[var(--ex-text-muted)]">
              Manage platform operations, AMM contracts, and user accounts
            </p>
          </div>

          <AdminPageClient>
            <AdminPanel />
            <AMMAdminPanel />
          </AdminPageClient>
        </main>
      </div>
    </Web3Provider>
  );
}
