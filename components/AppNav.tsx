"use client";

// components/AppNav.tsx
// Shared top navigation used across authenticated app pages
// (Trade, Staking, Cash Out, Fiat Swap, Dashboard).
//
// Layout:
//   • Desktop (lg+): horizontal pill bar with icon + label, no hamburger
//   • Mobile / tablet (< lg): hamburger button; sheet renders only when toggled
//
// We use the lg breakpoint (1024px) rather than md (768px) because the
// project ships with 5 nav items + brand, which start to crowd at md widths.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type NavItem = {
  href: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactElement;
};

const NAV_ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: ({ className }) => (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: "/trade",
    label: "Trade",
    icon: ({ className }) => (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    href: "/staking",
    label: "Staking",
    icon: ({ className }) => (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    ),
  },
  {
    href: "/cashout",
    label: "Cash Out",
    icon: ({ className }) => (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    ),
  },
  {
    href: "/swap",
    label: "Fiat Swap",
    icon: ({ className }) => (
      <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
  },
];

function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function HamburgerIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ) : (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export default function AppNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  return (
    <header className="sticky top-0 z-50 border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-3 group shrink-0">
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-400 to-cyan-500 rounded-xl blur-md opacity-50 group-hover:opacity-80 transition-opacity" />
            <div className="relative w-10 h-10 bg-gradient-to-br from-emerald-400 to-cyan-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/25">
              <span className="text-xl font-bold text-white">A</span>
            </div>
          </div>
          <span className="text-xl font-bold bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
            Exchange
          </span>
        </Link>

        {/* Desktop nav (lg and up).
            `app-nav__desktop` is a plain-CSS responsive guard in globals.css
            that overrides display based on min-width: 1024px. */}
        <nav className="app-nav__desktop items-center gap-1 bg-slate-800/40 border border-slate-700/40 rounded-2xl p-1.5">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "relative flex items-center gap-2 px-3 xl:px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 text-white ring-1 ring-emerald-400/30 shadow-inner"
                    : "relative flex items-center gap-2 px-3 xl:px-4 py-2 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-700/40 transition-colors"
                }
              >
                <Icon className={active ? "w-4 h-4 text-emerald-400" : "w-4 h-4 text-slate-500"} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Mobile hamburger (below lg only).
            `app-nav__mobile-trigger` is a plain-CSS responsive guard. */}
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          className="app-nav__mobile-trigger items-center justify-center w-10 h-10 rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-200 hover:text-white hover:bg-slate-700/50 transition-colors"
        >
          <HamburgerIcon open={mobileOpen} />
        </button>
      </div>

      {/* Mobile menu sheet — rendered only when toggled, hidden at lg+
          via the `app-nav__mobile-sheet` plain-CSS guard. */}
      {mobileOpen && (
        <div
          id="mobile-nav"
          className="app-nav__mobile-sheet border-t border-slate-700/50 bg-slate-900/95 backdrop-blur-xl"
        >
          <nav className="px-4 sm:px-6 py-3 flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const active = isActivePath(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                  className={
                    active
                      ? "flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium bg-gradient-to-r from-emerald-500/15 to-cyan-500/5 text-white ring-1 ring-emerald-400/30"
                      : "flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors"
                  }
                >
                  <span
                    className={
                      active
                        ? "flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/20 text-emerald-300"
                        : "flex items-center justify-center w-9 h-9 rounded-lg bg-slate-800/70 text-slate-400"
                    }
                  >
                    <Icon className="w-5 h-5" />
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {active && (
                    <span className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">
                      Current
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
