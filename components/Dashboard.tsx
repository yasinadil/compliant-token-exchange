// components/Dashboard.tsx
"use client";

// Dashboard ("Wallet Overview") — design from the Figma redesign.
//
// Layout (top-to-bottom):
//   1. Title block       — "Wallet Overview" + subtitle
//   2. Hero row          — total balance card (left, 2/5 width)
//                          + PLAT price/chart card (right, 3/5)
//   3. "Your tokens"     — 5 evenly-sized token cards
//                          (PLAT, USDX, EURX, GBPX, BRLX)
//   4. Transaction table — last few activity rows + "See all"
//
// All Web3 data (balances, USD rates, PLAT spot price, activity) is
// fetched through the `getDashboardSnapshot` server action so the page
// does ONE round-trip on mount and gracefully degrades if any single
// upstream service (Chainlink, AMM RPC, ledger DB) is down.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { UserSession } from "@/app/lib/auth-service";
import type { InternalWallet } from "@/app/lib/wallet-service";
import {
  getDashboardSnapshot,
  getFullActivityAction,
  getActivityCountAction,
  getPlatPriceHistoryAction,
  type DashboardSnapshot,
  type DashboardActivity,
} from "@/app/actions/dashboard";
import {
  ActivityTable,
  CompactActivityEmptyState,
  CompactActivityList,
  TransactionHistoryModal,
} from "@/components/ActivityHistory";
import { MobilePrimaryNav } from "@/components/AppShell";
import { ActivityTableSkeleton } from "@/components/Skeletons";

// Tokens supported by the platform, in display order.
// The incorrect GBP ticker spelling is intentionally NOT a key here; the canonical ticker is GBPX.
const TOKEN_ORDER = ["PLAT", "USDX", "EURX", "GBPX", "BRLX"] as const;
type TokenSymbol = (typeof TOKEN_ORDER)[number];

const TOKEN_META: Record<TokenSymbol, { name: string; iconSrc: string }> = {
  PLAT: { name: "PLAT", iconSrc: "/icons/plat.svg"},
  USDX: { name: "USDX", iconSrc: "/icons/usdx.svg" },
  EURX: { name: "EURX", iconSrc: "/icons/eurx.svg"},
  GBPX: { name: "GBPX", iconSrc: "/icons/gbpx.svg"},
  BRLX: { name: "BRLX", iconSrc: "/icons/brlx.svg"},
};

interface DashboardProps {
  // The page-level component passes session + wallet for future use
  // (e.g. wallet address chip, KYC banner). The dashboard itself loads
  // its own data via the `getDashboardSnapshot` server action.
  user: UserSession;
  wallet: InternalWallet | null;
}

export default function Dashboard({}: DashboardProps) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  // Lazy-fetched full activity for the "See all" modal. Starts at the
  // first page (50 rows) and grows as the user clicks "Load more".
  // Falls back to the snapshot's 8 rows while the first page loads.
  const [fullActivity, setFullActivity] = useState<DashboardActivity[] | null>(null);
  const [fullActivityLoading, setFullActivityLoading] = useState(false);
  // Separate flag for paginated subsequent fetches so the initial-load
  // skeleton and the "Load more" inline spinner don't fight over the
  // same state. Stays false except during the brief network roundtrip
  // of clicking the button.
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false);
  // Total activity count for the "Showing N of X transactions" hint —
  // Dashboard shows Exchange + Staking, so we use the `total` field.
  const [activityTotal, setActivityTotal] = useState<number | null>(null);
  // 7-day on-chain PLAT spot-price history for the Sparkline. Loaded
  // separately from the dashboard snapshot so a slow `getLogs` scan
  // doesn't block the headline + balances. `null` until resolved →
  // chart shows its existing placeholder; `[]` if the scan failed →
  // same placeholder; otherwise length-7 series of USDX-per-PLAT
  // prices, oldest → newest.
  const [priceHistory, setPriceHistory] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [snapRes, countRes] = await Promise.all([
        getDashboardSnapshot(),
        getActivityCountAction(),
      ]);
      if (cancelled) return;
      if (snapRes.success) {
        setSnapshot(snapRes.data);
        setError(null);
      } else {
        setError(snapRes.error);
      }
      if (countRes.success) setActivityTotal(countRes.data.total);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Independent fetch for the on-chain price history. Runs in parallel
  // with the snapshot — chart resolves on its own timeline.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getPlatPriceHistoryAction();
      if (cancelled) return;
      // Use [] (empty array, distinct from `null`) on failure so the
      // chart can distinguish "still loading" from "tried and failed".
      setPriceHistory(res.success ? res.data : []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull the full history the first time the user opens the modal.
  // Subsequent opens reuse the cached array.
  //
  // We deliberately DO NOT include `fullActivityLoading` in the deps or
  // the guard: `setFullActivityLoading(true)` is called inside the IIFE,
  // and if the loading flag participated in the dep array, that state
  // change would trigger the effect's own cleanup to set `cancelled =
  // true` mid-fetch — the fetch would resolve and bail before it could
  // store the result, leaving the modal stuck on the skeleton. Guarding
  // on `fullActivity` alone is sufficient: once we successfully fetched
  // the list, we never refetch.
  useEffect(() => {
    if (!activityModalOpen || fullActivity) return;
    let cancelled = false;
    (async () => {
      setFullActivityLoading(true);
      const res = await getFullActivityAction();
      if (cancelled) return;
      setFullActivityLoading(false);
      if (res.success) setFullActivity(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [activityModalOpen, fullActivity]);

  // Empty-state preview (dev): to see a section's empty design, replace
  // its data line below with the commented "EMPTY STATE FUNCTION" line.

  // EMPTY STATE FUNCTION - total balance - const totalUsd: number | null = 0;

  const totalUsd = snapshot?.totalUsd ?? null;

  // EMPTY STATE FUNCTION - your tokens - const balances: DashboardSnapshot["balances"] = [];

  const balances = snapshot?.balances ?? [];

  // EMPTY STATE FUNCTION - recent activity - const activity: DashboardActivity[] = [];

  const activity = snapshot?.activity ?? [];

  // No early-return on `loading` here: each card below already paints
  // its static chrome (gradient bg, labels, action buttons, token names,
  // chart axis/placeholder, table headers) immediately and only pulses
  // the actual dynamic values it's waiting for. A blanket
  // `<DashboardSkeleton />` would clobber that selective behavior with
  // big grey rectangles for the whole layout — which is exactly what
  // we don't want.

  return (
    <div>
      {/* ── Title ───────────────────────────────────────────── */}
      {/* Header + h1 + subtitle classes mirror the Exchange and Staking
          pages so the title and subtitle don't shift when the user
          navigates between Dashboard / Exchange / Staking. If you change
          one, change the other two (components/Exchange.tsx,
          components/Staking.tsx). */}
      <header className="flex flex-col gap-5 text-center sm:text-left lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#4B5563]">
            PLAT Tokens Wallet
          </h1>
          <p className="font-display mt-1 text-sm text-[#4B5563]">
            See your balances, transactions, and the PLAT price at a glance.
          </p>
        </div>
        <DashboardWalletMenu />
      </header>
      <MobilePrimaryNav className="mt-6" />
      {error && (

        <div className="ex-card p-4 border-red-200 bg-red-50 text-sm text-red-700">
          <p>
            We couldn&apos;t load some of your dashboard data. Try refreshing
            — if it keeps happening, please come back in a few minutes.
          </p>
          {/* Raw server error tucked behind a disclosure so the friendly
              message reads first. Useful for power users / bug reports
              without alarming non-technical users with stack traces. */}
          <details className="mt-2 text-xs text-red-600/80">
            <summary className="cursor-pointer">Show technical details</summary>
            <p className="mt-1 break-words font-mono">{error}</p>
          </details>
        </div>
      )}

      {/* ── Hero row: total balance + PLAT chart ───────── */}
      <section className="mt-8 grid items-stretch gap-5 lg:grid-cols-[minmax(420px,0.9fr)_minmax(520px,1.1fr)]">
        <TotalBalanceCard
          totalUsd={totalUsd}
          loading={loading}
        />
        <PlatPriceCard
          priceUsd={snapshot?.platPriceUsd ?? null}
          priceHistory={priceHistory}
          loading={loading}
        />
      </section>

      {/* ── Your tokens ─────────────────────────────────────── */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[24px] text-[#4B5563] font-semibold">Your PLAT Tokens</h2>
          {/* Permanent shortcut into the Exchange buy flow. */}
          <Link
            href="/exchange?mode=buy"
            className="seeall-recentactivity text-xs font-medium px-4 py-1.5 border-1 border-transparent rounded-[4px] text-white bg-[#0EA5E9] transition-colors"
          >
            Buy Tokens
          </Link>
        </div>
        <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
          {TOKEN_ORDER.map((sym) => {
            const balance = balances.find((b) => b.token_symbol === sym);
            const rate = snapshot?.rates?.[sym] ?? (sym === "USDX" ? 1 : null);
            return (
              <TokenCard
                key={sym}
                symbol={sym}
                balance={balance?.balance ?? "0"}
                usdRate={rate}
                loading={loading}
              />
            );
          })}
        </div>
      </section>

      {/* ── Transaction history ─────────────────────────────── */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[18px] sm:text-[24px] text-[#4B5563] font-semibold">Recent activity</h2>
          <div className="flex items-center gap-3">
            {activityTotal != null && activityTotal > 0 && (
              <span className="hidden sm:inline text-xs text-[var(--ex-text-muted)]">
                Showing {Math.min(activity.length, activityTotal)}{" "}
                of {activityTotal} items
              </span>
            )}
            <button
              type="button"
              onClick={() => setActivityModalOpen(true)}
              className="seeall-recentactivity text-xs font-medium px-4 py-1.5 border-1 border-transparent rounded-[4px] text-white bg-[#0EA5E9] transition-colors cursor-pointer"
            >
              See all
            </button>
          </div>
        </div>
        {loading ? (
          <>
            <div className="md:hidden">
              <ActivityTableSkeleton rows={4} />
            </div>
            <div className="hidden md:block">
              <ActivityTableSkeleton rows={4} withHeader />
            </div>
          </>
        ) : activity.length > 0 ? (
          <>
            <div className="md:hidden">
              <CompactActivityList rows={activity.slice(0, 4)} />
            </div>
            <div className="hidden md:block">
              <ActivityTable rows={activity} loading={false} />
            </div>
          </>
        ) : (
          <>
          <div className="md:hidden">
            <CompactActivityEmptyState />
          </div>
          <div className="ex-card hidden md:block overflow-hidden">
            <div className="grid min-h-[64px] grid-cols-[1.2fr_1fr_1fr_0.9fr_0.8fr] items-center bg-[#F9FAFB] px-6 text-[16px] font-semibold text-[#374151]">
              <span>Action</span>
              <span>Paid</span>
              <span>Received</span>
              <span>Date</span>
              <span>Status</span>
            </div>

            <div className="flex min-h-[112px] items-center justify-center gap-5 border-t border-[#E5E7EB] bg-white px-6 py-7">
              <img
                src="/icons/no-recent-activity.svg"
                alt=""
                aria-hidden
                className="h-[54px] w-[54px] shrink-0 object-contain opacity-80"
              />
              <p className="font-sans text-[24px] font-semibold leading-[32px] text-[rgba(17,24,39,0.4)]">
                No recent activity
              </p>
            </div>
          </div>
          </>
        )}
      </section>
      {activityModalOpen && (() => {
        // Prefer the full lazy-loaded list; fall back to the snapshot's
        // 8 rows so the modal is never blank while the longer fetch is
        // in flight. Only render the skeleton when we have nothing yet
        // — otherwise we'd hide the snapshot rows we already have.
        const modalRows = fullActivity ?? activity;
        const modalLoading =
          modalRows.length === 0 && (fullActivityLoading || loading);
        // "Load more" is available when we've finished the first page
        // and the server count says there are more rows than what's
        // currently shown. While the first page is still loading we
        // hide the button (the modal is in skeleton state anyway).
        const hasMore =
          fullActivity != null &&
          activityTotal != null &&
          fullActivity.length < activityTotal;
        const loadMoreActivity = async () => {
          if (loadingMoreActivity || !fullActivity) return;
          setLoadingMoreActivity(true);
          // Fetch the next page starting at the current row count —
          // server returns the next 50 from the merged feed.
          const res = await getFullActivityAction(
            "all",
            50,
            fullActivity.length
          );
          setLoadingMoreActivity(false);
          if (res.success && res.data.length > 0) {
            setFullActivity([...fullActivity, ...res.data]);
          }
        };
        return (
          <TransactionHistoryModal
            rows={modalRows}
            loading={modalLoading}
            onClose={() => setActivityModalOpen(false)}
            onLoadMore={loadMoreActivity}
            hasMore={hasMore}
            loadingMore={loadingMoreActivity}
          />
        );
      })()}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Total balance card (hero, left)
   ───────────────────────────────────────────────────────────── */
function DashboardWalletMenu() {
  return (
    <nav
      aria-label="Wallet category"
      className="mx-auto flex h-[40px] w-full max-w-[500px] shrink-0 items-center rounded-full bg-[#FFFFFF] p-1 shadow-sm lg:mx-0 lg:mt-1"
    >
      <button
        type="button"
        disabled
        className="flex h-full flex-1 cursor-default items-center justify-center whitespace-nowrap rounded-full px-3 font-sans text-[12px] font-medium text-[#374151]"
      >
        ALL WALLETS
      </button>
      <button
        type="button"
        disabled
        className="flex h-full flex-1 cursor-default items-center justify-center rounded-full px-3 font-sans text-[12px] font-medium text-[#374151]"
      >
        FIAT WALLET
      </button>
      <Link
        href="/"
        aria-current="page"
        className="flex h-full flex-1 items-center justify-center rounded-full bg-[#0EA5E9] px-3 font-sans text-[12px] font-semibold text-[#FFFFFF]"
      >
        TOKENS WALLET
      </Link>
    </nav>
  );
}

function TotalBalanceCard({
  totalUsd,
  loading,
}: {
  totalUsd: number | null;
  loading: boolean;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-[10px] px-9 pt-9 pb-8 h-full min-h-[252px] text-white shadow-sm ring-1 ring-inset ring-white/65"
      style={{
        background:
          "linear-gradient(90deg, #011017 0%, #08638C 50%, #3EB7ED 100%)",
      }}
    >
    <div
      aria-hidden
      className="absolute inset-0 z-0 rounded-[9px] backdrop-blur-[100px] opacity-60"
      style={{
        background:
          "linear-gradient(150deg, rgba(255,255,255,0.50) -10%, rgba(255,255,255,0.01) 100%)",
        backgroundSize: "150% 150%",
        backgroundPosition: "left center",
      }}
    />

    {/* Decorative background graphics — gradient-stroked circles per
        the Figma spec. SVG is used so the strokes can carry a linear
        gradient with multiple stops (CSS borders can't). All purely
        decorative: `aria-hidden`, behind the content (z-0), and
        pointer-events-none so they never intercept clicks. The card's
        `overflow-hidden` crops the off-card portions to the rounded
        corners. */}

    {/* Top-right cluster — two overlapping FILLED circles, both with
        the same linear gradient (#B7E4F8 → #08638C at -92°), each at
        50 % opacity so the overlap composites the way Figma renders. */}
    <svg
      aria-hidden
      className="pointer-events-none absolute -top-[140px] -right-[100px] z-0"
      width="360"
      height="355"
      viewBox="0 0 360 355"
    >
      <defs>
        <linearGradient
          id="hero-tr-fill"
          gradientUnits="objectBoundingBox"
          gradientTransform="rotate(-92 0.5 0.5)"
        >
          <stop offset="0%" stopColor="#B7E4F8" />
          <stop offset="100%" stopColor="#08638C" />
        </linearGradient>
      </defs>
      <circle
        cx="125"
        cy="125"
        r="124"
        fill="url(#hero-tr-fill)"
        opacity="0.3"
      />
      <circle
        cx="230"
        cy="220"
        r="124"
        fill="url(#hero-tr-fill)"
        opacity="0.3"
      />
    </svg>

    {/* Bottom-left ring — single stroked circle with a 4-stop linear
        gradient (#D3EFFC fade-in 0→20 % → #5395BB at 52 % → #245878 at
        69 %, rotated -22°). Whole circle at 50 % opacity. CIRCULO DE ABAJO HERO */}
    {/*<svg
      aria-hidden
      className="pointer-events-none absolute -bottom-[130px] -left-[130px] z-0"
      width="246"
      height="248"
      viewBox="0 0 246 248"
      fill="none"
    >
      <defs>
        <linearGradient
          id="hero-bl-stroke"
          gradientUnits="objectBoundingBox"
          gradientTransform="rotate(45 0.5 0.5)"
        >
          <stop offset="0%" stopColor="#D3EFFC" stopOpacity="0" />
          <stop offset="30%" stopColor="#D3EFFC" stopOpacity="1" />
          <stop offset="60%" stopColor="#5395BB" stopOpacity="1" />
          <stop offset="100%" stopColor="#245878" stopOpacity="1" />
        </linearGradient>
      </defs>
      <circle
        cx="123"
        cy="124"
        r="121"
        stroke="url(#hero-bl-stroke)"
        strokeWidth="2"
        opacity="0.5"
      />
    </svg> */}

    <div className="relative z-10 flex h-full flex-col">
      {/* Balance block vertically centered in the space above the action
          buttons (`flex-1` + `justify-center`). `mb-2` gives breathing room
          before the buttons; "Your total balance" gets its own `mb-2`. */}
      <div className="mb-2 flex flex-1 flex-col justify-center">
        <p className="mb-4 text-[18px] font-medium leading-none text-white">Your total balance</p>
        <div>
          {loading ? (
            <div className="h-12 w-40 rounded-md bg-white/10 animate-pulse" />
          ) : (
            <p
              className="font-sans text-white leading-none"
              style={{ fontSize: "48px", fontWeight: 600 }}
            >
              {/* Size/weight set inline: the Tailwind text-[50px]/font-semibold
                  utilities weren't applying here (same cascade-layer issue as
                  the hero buttons), so the number fell back to the inherited
                  body size and looked tiny. Inline style reliably wins the
                  cascade. Font family is Inter, inherited from <body>. */}
              {formatUsd(totalUsd ?? 0)}
            </p>
          )}
        </div>
        <p className="mt-2 ml-1 text-[13px] leading-none text-white/90">
          Estimated value in USD
        </p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <QuickAction href="/exchange?mode=buy" label="Buy" iconSrc="/icons/buy.svg"  />
        <QuickAction href="/exchange?mode=sell" label="Sell" iconSrc="/icons/sell.svg" />
        <QuickAction href="/exchange?mode=swap" label="Convert" iconSrc="/icons/convert.svg"  />
        <QuickAction href="/staking" label="Earn"  iconSrc="/icons/earn.svg" />
      </div>
    </div></div>
  );
}

function QuickAction({
  href,
  label,
  iconSrc,
}: {
  href: string;
  label: string;
  iconSrc: string;
}) {
  return (
    // Frosted-glass action button matching the Figma hero design: a
    // translucent white fill with a softened border and subtle elevation over
    // the blue gradient. The fill (`background`), frost (`backdropFilter`), and
    // shadow
    // are set inline rather than via Tailwind utilities — the utility
    // versions weren't taking effect here (Tailwind utilities live in a
    // `@layer`, so inline styles reliably win the cascade). `-webkit-`
    // prefix included for Safari. Text and icons use the card's deep blue.
    <Link
      href={href}
      style={{
        background: "rgba(255,255,255,0.75)",
        backdropFilter: "blur(50px)",
        WebkitBackdropFilter: "blur(50px)",
        borderWidth: "1px",
        borderRadius: "5px",
        borderStyle: "solid",
        borderColor: "rgba(255,255,255,0.14)",
        boxShadow:
          "0 8px 18px rgba(1,16,23,0.18), inset 0 0px 0 rgba(255,255,255,0.16)",
        color: "#063C54",
      }}
      className="flex items-center justify-center gap-1.5 sm:gap-2 min-h-[40px] px-3 sm:px-4 text-[12px] sm:text-[14px] font-medium transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
      {/* `filter` set inline for the same cascade-layer reason as the button's
          fill/blur above, tinting source icons to the same deep blue. */}
      <img
        src={iconSrc}
        alt=""
        style={{
          filter:
            "brightness(0) saturate(100%) invert(19%) sepia(47%) saturate(1120%) hue-rotate(158deg) brightness(89%) contrast(96%)",
        }}
        className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0"
      />
      <span>{label}</span>
    </Link>
  );
}

const ArrowDownIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v10m0 0-4-4m4 4 4-4" />
  </svg>
);
const ArrowUpIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 13V3m0 0L4 7m4-4 4 4" />
  </svg>
);
const SwapIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h9l-2-2M12 11H3l2 2" />
  </svg>
);
const EarnIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="m3 12 4-4 3 3 3-5" />
  </svg>
);

/* ─────────────────────────────────────────────────────────────
   PLAT price card (hero, right)
   Renders the AMM spot price + a self-contained SVG sparkline.
   When there is no live data we still render a labelled placeholder
   ready to be wired to a real price-history endpoint later.
   ───────────────────────────────────────────────────────────── */
function PlatPriceCard({
  priceUsd,
  priceHistory,
  loading,
}: {
  priceUsd: number | null;
  /**
   * 7-day on-chain spot-price series, oldest → newest.
   *   • `null`    → still loading (chart shows placeholder)
   *   • `[]`      → fetch failed (chart shows placeholder)
   *   • length 7+ → real on-chain history
   */
  priceHistory: number[] | null;
  loading: boolean;
}) {
  // Use the real on-chain series when available; otherwise render
  // nothing (the Sparkline's existing loading state covers it).
  const series = priceHistory && priceHistory.length >= 2 ? priceHistory : [];
  const trendPct = computeTrend(series);
  const chartLoading = loading || priceHistory == null;
  const chartMeta = buildDailyChartMeta();

  return (
    <div
      className="ex-card h-full px-5 py-4 lg:px-8 lg:py-6 flex flex-col"
      style={{ "--ex-card-radius": "12px" } as React.CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          {/* Eyebrow labels the big number as the *current* spot price.
              The chart-window label ("Past 7 days") sits below the price,
              right above the Sparkline, so it clearly refers to the chart
              rather than the headline number. */}
          <p className="font-display text-[14px] font-medium text-[#4B5563] leading-none">
            PLAT Price
          </p>
          {loading ? (
            <div className="mt-3 h-8 w-24 rounded-md bg-slate-100 animate-pulse" />
          ) : priceUsd != null ? (
            <p className="mt-3 font-display text-[32px] font-bold text-[#111827] leading-none">
              {formatUsd(priceUsd, { maxFractionDigits: 2 })}
            </p>
          ) : (
            <p className="mt-5 font-display text-[20px] font-semibold text-[var(--ex-text-muted)] leading-none">
              Live price unavailable
            </p>
          )}
        </div>
         <div className="flex items-center gap-2 shrink-0 pt-4">
          {trendPct != null && (
            <span className="inline-flex items-center gap-1 px-4 py-1 rounded-full text-xs font-normal bg-[#D0EDD3] text-[#48A86D]">
            <img src="/icons/trendup.svg" alt="" className="h-3.5 w-3.5" />
            {trendPct >= 0 ? "+" : ""}
            {trendPct.toFixed(2)}% past 7 days
          </span>
          )}

        </div>
      </div>

      <Sparkline
        series={series}
        loading={chartLoading}
        axisTicks={chartMeta.axisTicks}
        tooltipText={chartMeta.tooltipText}
      />
    </div>
  );
}

/** Chart metadata shape used by the Sparkline x-axis + tooltips. */
interface ChartMeta {
  /** X-axis ticks. `position` is a 0..1 fraction of the chart width. */
  axisTicks: { label: string; position: number }[];
  /** One tooltip string per data point (matches `series` length). */
  tooltipText: string[];
}

/**
 * Daily metadata: rolling 7-day window ending today. 7 ticks at the
 * centers of each daily column (matches data-point positions 1:1).
 * Labels use weekday abbreviations ("Mon", "Tue", …) except the most
 * recent, which reads "Today". Tooltips keep the full `"Weekday, D Mon"`
 * date (e.g. `"Wed, 27 May"`).
 */
function buildDailyChartMeta(): ChartMeta {
  const today = new Date();
  const out: ChartMeta = { axisTicks: [], tooltipText: [] };
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - 6 + i); // 6 days ago … today
    const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
    const month = d.toLocaleDateString("en-US", { month: "short" });
    // X-axis label: the most recent day reads "Today" (i === 6); every
    // earlier day shows its weekday abbreviation ("Mon", "Tue", …).
    // Tooltips keep the full "Weekday, D Mon" date.
    const label = i === 6 ? "Today" : weekday;
    out.axisTicks.push({
      label,
      position: (i + 0.5) / 7,
    });
    out.tooltipText.push(`${weekday}, ${d.getDate()} ${month}`);
  }
  return out;
}

/**
 * Builds the chart's Y-axis from the data so it auto-scales to the
 * price: takes the week's low/high, pads it ~20% so the line isn't
 * flush against the edges, snaps the bounds to "nice" round numbers,
 * and returns the gridline tick values. A flat series (every point
 * equal) falls back to a small band around the value so the line sits
 * mid-chart instead of dividing by a zero range.
 */
function buildYScale(series: number[]): {
  min: number;
  max: number;
  ticks: number[];
} {
  let lo = Math.min(...series);
  let hi = Math.max(...series);

  if (hi - lo < 1e-9) {
    const v = Math.abs(hi) > 1e-9 ? hi : 1;
    lo = v * 0.9;
    hi = v * 1.1;
  } else {
    const pad = (hi - lo) * 0.2;
    lo -= pad;
    hi += pad;
  }
  lo = Math.max(0, lo);

  // Snap the bounds to multiples of a "nice" step (…0.05, 0.1, 0.2…) so
  // the labels read cleanly. Targeting ~4 gaps yields roughly 5 ticks
  // for a typical $0.20 price range.
  const step = niceNumber((hi - lo) / 3);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  for (let t = max; t > min - step / 2; t -= step) {
    ticks.push(Number(t.toFixed(6)));
  }
  return { min, max, ticks };
}

/** Rounds a raw step up to the nearest 1 / 2 / 5 × 10ⁿ. */
function niceNumber(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function Sparkline({
  series,
  loading,
  axisTicks,
  tooltipText,
}: {
  series: number[];
  loading: boolean;
  /**
   * X-axis labels with explicit positions (0..1 fraction of chart width).
   * Decoupled from `series.length` so a 24-point hourly series can render
   * 7 ticks at 4-hour intervals while the daily mode keeps its 1:1
   * label-per-point layout.
   */
  axisTicks: { label: string; position: number }[];
  /**
   * Per-point tooltip text (length must equal `series.length`). Daily
   * mode passes "Wed, 27 May"; hourly passes "Wed, 27 May, 14:00".
   */
  tooltipText: string[];
}) {
  const W = 600;
  // SVG viewBox height in user units. The chart stretches to fill its
  // container (preserveAspectRatio="none" + h-full) and the dots are
  // positioned as a % of height, so this value only defines the internal
  // coordinate space — the visible chart height is driven by the
  // `h-[140px]` container classes below, kept equal to this for clarity.
  const H = 140;

  // Index of the data point the user is hovering — drives the tooltip.
  const [hover, setHover] = useState<number | null>(null);

  // Two distinct placeholders, kept separate on purpose:
  //   • `loading=true` → fetch in flight. Pulsing skeleton, consistent
  //     with the value-skeletons used elsewhere in the dashboard, tells
  //     the user the data is on its way.
  //   • `series.length < 2` → fetch already resolved with no/insufficient
  //     data (e.g. `getLogs` failed and we set `priceHistory=[]`). A
  //     pulsing skeleton here would lie — nothing is loading anymore —
  //     so we render the explanatory text instead.
  // Do NOT collapse these branches back into one, or a failed fetch
  // will pulse forever.
  if (loading) {
    return (
      // Height via inline style (not the arbitrary `h-[168px]` class, which
      // wasn't applying here — same Tailwind issue as elsewhere). 168px =
      // the real chart's footprint (h-[140px] chart + mt-3 + 16px x-axis),
      // so the skeleton reserves the exact space and the card doesn't jump
      // when the chart loads. Animation comes from `animate-pulse`.
      <div
        className="mt-8 rounded-lg bg-slate-100 animate-pulse"
        style={{ height: "168px" }}
      />
    );
  }

  if (series.length < 2) {
    return (
      <div
        className="mt-8 rounded-lg bg-slate-50 ring-1 ring-[var(--ex-border)] flex items-center justify-center text-xs text-[var(--ex-text-subtle)]"
        style={{ height: "168px" }}
      >
        Chart will appear once price data is available
      </div>
    );
  }

  // Y-axis bounds + gridline ticks are derived from the week's data so
  // the chart stays readable whatever the price does (see buildYScale).
  const { min, max, ticks: yTicks } = buildYScale(series);
  const range = Math.max(max - min, 1e-9);

  const valueToY = (v: number) => {
    return (1 - (v - min) / range) * H;
  };

  const tickToTop = (tick: number) => {
    return `${((max - tick) / range) * 100}%`;
  };

  const points = series.map((v, i) => {
    // Center each point within its column so the dots line up with the
    // weekday labels below (the x-axis labels are a centered 7-col grid).
    const x = ((i + 0.5) / series.length) * W;
    const y = valueToY(v);
    return [x, y] as const;
  });

  // The dots stay centered over their day columns, but the line + area
  // are extended to the chart edges by extrapolating the slope of the
  // first and last segments, so the graphic spans the full plot width
  // instead of stopping at the first / last dot.
  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const secondLast = points[points.length - 2];
  const edgeLeftY =
    first[1] - (second[1] - first[1]) * (first[0] / (second[0] - first[0]));
  const edgeRightY =
    last[1] +
    (last[1] - secondLast[1]) * ((W - last[0]) / (last[0] - secondLast[0]));

  const path =
    `M0,${edgeLeftY.toFixed(2)} ` +
    points.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(" ") +
    ` L${W},${edgeRightY.toFixed(2)}`;

  const area =
    `M0,${H} L0,${edgeLeftY.toFixed(2)} ` +
    points.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(" ") +
    ` L${W},${edgeRightY.toFixed(2)} L${W},${H} Z`;

  return (
    <div className="mt-8 grid grid-cols-[34px_minmax(0,1fr)]">
      {/* Y axis labels — inline `fontFamily` so we know exactly which
          font renders, instead of relying on class-cascade inheritance
          that was producing ambiguous results at this small size. */}
      <div
        className="relative h-[140px]"
        style={{
          fontFamily:
            "var(--font-inter), system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {yTicks.map((tick) => (
          <span
            key={tick}
            className="absolute right-2 -translate-y-1/2 text-[11px] text-[#111827]"
            style={{ top: tickToTop(tick) }}
          >
            ${tick.toFixed(2)}
          </span>
        ))}
      </div>

          {/* Chart */}
          <div
            className="relative h-[140px] overflow-visible"
            onMouseLeave={() => setHover(null)}
          >
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-full w-full overflow-visible"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#0EA5E9" />
                  <stop offset="100%" stopColor="#C5C5C5" />
                </linearGradient>
              </defs>

              {yTicks.map((tick) => {
                const y = valueToY(tick);

                return (
                  <line
                    key={tick}
                    x1={0}
                    x2={W}
                    y1={y}
                    y2={y}
                    stroke="#E5E7EB"
                    strokeWidth={1}
                  />
                );
              })}

              <path d={area} fill="url(#sparkFill)" opacity="0.2" />
              <path
                d={path}
                fill="none"
                stroke="#0EA5E9"
                strokeWidth={2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              </svg>

              {/* HTML dots: always perfectly round. The hovered point
                  gets a larger dot with a white ring. */}
              {points.map(([x, y], i) => (
                <span
                  key={i}
                  className={
                    hover === i
                      ? "absolute h-[12px] w-[12px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0EA5E9] ring-2 ring-white shadow-md"
                      : "absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0EA5E9]"
                  }
                  style={{
                    left: `${(x / W) * 100}%`,
                    top: `${(y / H) * 100}%`,
                  }}
                />
              ))}

              {/* Invisible per-point hover zones — a vertical band around
                  each data point so the tiny dot is easy to hover. */}
              {points.map(([x], i) => {
                const xPct = (x / W) * 100;
                const prevPct = i > 0 ? (points[i - 1][0] / W) * 100 : xPct;
                const nextPct =
                  i < points.length - 1 ? (points[i + 1][0] / W) * 100 : xPct;
                const left = i === 0 ? 0 : (prevPct + xPct) / 2;
                const right =
                  i === points.length - 1 ? 100 : (xPct + nextPct) / 2;
                return (
                  <div
                    key={i}
                    className="absolute top-0 h-full cursor-pointer"
                    style={{ left: `${left}%`, width: `${right - left}%` }}
                    onMouseEnter={() => setHover(i)}
                  />
                );
              })}

              {/* Tooltip — exact date + token value for the hovered point.
                  The box is clamped to the chart edges and the pointer
                  notch is clamped to stay inside the box, so the first and
                  last points render cleanly instead of overflowing. */}
              {hover !== null && (() => {
                const xPct = (points[hover][0] / W) * 100;
                const yPct = (points[hover][1] / H) * 100;
                const BOX_W = 180; // tooltip width, px
                const NOTCH_PAD = 32; // min gap between notch and box corner, px
                // Box left edge: centered on the point, clamped so the box
                // never leaves the chart on either side.
                const boxLeft = `clamp(0px, calc(${xPct}% - ${BOX_W / 2}px), calc(100% - ${BOX_W}px))`;
                // Notch x: points at the dot, clamped to stay inside the box.
                const notchLeft = `clamp(calc(${boxLeft} + ${NOTCH_PAD}px), ${xPct}%, calc(${boxLeft} + ${BOX_W - NOTCH_PAD}px))`;
                return (
                  <>
                    <div
                      className="pointer-events-none absolute z-20 w-[180px] -translate-y-full rounded-[10px] bg-[#0F1C2E] px-4 py-2.5 text-center shadow-lg"
                      style={{ left: boxLeft, top: `calc(${yPct}% - 18px)` }}
                    >
                      <p className="text-[13px] font-semibold leading-tight text-white whitespace-nowrap">
                        1 PLAT → {formatUsd(series[hover], { maxFractionDigits: 2 })}
                      </p>
                      <p className="mt-1 text-[12px] leading-tight text-white/70 whitespace-nowrap">
                        {tooltipText[hover]}
                      </p>
                    </div>
                    {/* Pointer notch — points at the dot, kept inside the box. */}
                    <div
                      className="pointer-events-none absolute z-20 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#0F1C2E]"
                      style={{ left: notchLeft, top: `calc(${yPct}% - 18px)` }}
                    />
                  </>
                );
              })()}
          </div>
      <div />

      {/* X axis labels — absolutely positioned at the fractional `position`
          each tick carries (0..1 of chart width). Daily mode hands us 7
          ticks at the centers of 7 columns (1:1 with data points); hourly
          mode hands us 7 ticks at 4-hour boundaries over 24 data points.
          Edge ticks (position 0 / position 1) anchor to the chart edges
          without overflow; middle ticks are centered on their position. */}
      <div
        className="relative mt-3 h-[16px] text-[11px] text-[#111827]"
        style={{
          fontFamily:
            "var(--font-inter), system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {axisTicks.map((t, i) => {
          const isLeftEdge = t.position <= 0.001;
          const isRightEdge = t.position >= 0.999;
          const style: React.CSSProperties = isLeftEdge
            ? { left: 0 }
            : isRightEdge
            ? { right: 0 }
            : { left: `${t.position * 100}%`, transform: "translateX(-50%)" };
          return (
            <span
              key={i}
              className="absolute whitespace-nowrap"
              style={style}
            >
              {t.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function computeTrend(series: number[]): number | null {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (!first) return null;
  return ((last - first) / first) * 100;
}

/* ─────────────────────────────────────────────────────────────
   Token card (one of five)
   ───────────────────────────────────────────────────────────── */
function TokenCard({
  symbol,
  balance,
  usdRate,
  loading,
}: {
  symbol: TokenSymbol;
  balance: string;
  usdRate: number | null;
  loading: boolean;
}) {
  const meta = TOKEN_META[symbol];
  const amt = parseFloat(balance);
  const usd = usdRate != null && Number.isFinite(amt) ? amt * usdRate : null;

  return (
    <div className="ex-card px-5 py-4 min-h-[112px] flex flex-col justify-between"
       style={{ "--ex-card-radius": "8px" } as React.CSSProperties}>
      <div className="flex items-center gap-2 shrink-0">
        <img
          src={meta.iconSrc}
          alt=""
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
        <span className="text-[16px] font-semibold text-[#4B5563]">{meta.name}</span>
      </div>
      <div className="text-right">
        {loading ? (
        <div className="ml-auto h-7 w-24 rounded-md bg-slate-100 animate-pulse" />
      ) : (
        <p className="font-display text-[22px] font-semibold text-[#4B5563]">
          {formatTokenAmount(amt)}
        </p>
      )}
      <p className="text-[13px] text-[#818892]">
        {loading
          ? " "
          : amt > 0
          ? `≈ ${usd != null ? formatUsd(usd) : "—"} USD`
          : "Not in your balance yet"}
      </p>
    </div>
      </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   Formatters
   ───────────────────────────────────────────────────────────── */
function formatUsd(n: number, opts: { maxFractionDigits?: number } = {}): string {
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: opts.maxFractionDigits ?? 2,
  });
}

/**
 * Dashboard per-token balance formatter. 2-decimal standard with one
 * carve-out: sub-cent dust (0 < n < 0.01) renders as "0.00" so the
 * empty-state UX (e.g. Staking's "Buy Tokens" CTA) fires when a user's
 * spendable balance is effectively zero. All other balances round to
 * 2 decimals.
 */
function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  if (n > 0 && n < 0.01) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
