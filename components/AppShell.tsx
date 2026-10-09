"use client";

// components/AppShell.tsx
//
// New "Def" shell from the Figma redesign.
// • Top header  — deep-blue gradient, brand on the left, pill-segmented
//                 nav (Dashboard / Exchange / Rewards) on the right, plus
//                 a notification bell.
// • Left rail   — narrow dark-navy icon sidebar (lg+), with the Exchange "A"
//                 logo pinned at the bottom.
// • Main slot   — light gray canvas (`bg-[var(--ex-bg)]`) hosting page
//                 content as rounded cards.
//
// The shell is intentionally presentational: it does not fetch data and
// does not own any Web3 state. Wallet / balances / contract logic lives
// inside the page-level components rendered as children.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/app/context/AuthContext";
import {
  adminCancelAllPendingAction,
  adminRecoverBulkCancelledCashoutsAction,
} from "@/app/actions/admin-debug";
import { ModalCloseButton } from "@/components/ModalCloseButton";

type IconProps = { className?: string };

type ImageIconProps = IconProps & {
  src: string;
};

type AmmTradeMode = "purchase" | "sale";

type AmmImpactResult = {
  impactPct: number | null;
  warning: string | null;
};

const sanitizeCalculatorNumber = (value: string, decimals = 2) => {
  // Strip non-numeric chars, collapse to a single decimal point, then keep at
  // most `decimals` digits after it.
  const cleaned = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
  const dot = cleaned.indexOf(".");
  return dot === -1 ? cleaned : cleaned.slice(0, dot + 1 + decimals);
};

const toFiniteNumber = (value: string | number | null | undefined) => {
  const n = typeof value === "number" ? value : parseFloat(value ?? "");
  return Number.isFinite(n) ? n : null;
};

const formatEditableNumber = (value: number, decimals = 2) => {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, "");
};

const formatDisplayNumber = (value: number, decimals = 2) =>
  Number.isFinite(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    : "—";

// ── Launch Liquidity Planner — AMM math ─────────────────────────────
// Pure helpers shared by the planner's two modes. They mirror the PermissionedAMM
// constant-product (x·y=k) math so pre-launch estimates line up with
// on-chain behaviour once the pool is seeded. English-only; numbers use
// en-US formatting so the '.'-decimal input parsing stays valid.

// Swap fee assumed before the pool exists. Matches PermissionedAMM's constructor
// default (swapFeeBps = 30 → 0.3%). The real fee can be changed on-chain
// later; this is only the planning assumption.
const LAUNCH_SWAP_FEE_BPS = 30;

// Upper bound for the budget / price / trade-size inputs (100M).
const FIELD_MAX = 100_000_000;

function estimateAmmImpact({
  mode,
  amountAsset,
  liquidityUsdx,
  spotPrice,
  swapFeeBps,
}: {
  mode: AmmTradeMode;
  amountAsset: number;
  liquidityUsdx: number;
  spotPrice: number;
  swapFeeBps: number;
}): AmmImpactResult {
  if (amountAsset <= 0 || liquidityUsdx <= 0 || spotPrice <= 0) {
    return { impactPct: null, warning: null };
  }

  const feeMultiplier = 1 - swapFeeBps / 10000;
  if (feeMultiplier <= 0) {
    return {
      impactPct: null,
      warning: "The swap fee is too high to estimate this simulation.",
    };
  }

  const reserveAsset = liquidityUsdx / spotPrice;

  if (mode === "sale") {
    const amountInWithFee = amountAsset * feeMultiplier;
    const actualOut =
      (amountInWithFee * liquidityUsdx) / (reserveAsset + amountInWithFee);
    const expectedOut = amountAsset * spotPrice;
    const impact = Math.max(0, 1 - actualOut / expectedOut) * 100;
    return { impactPct: impact, warning: null };
  }

  if (amountAsset >= reserveAsset) {
    return {
      impactPct: null,
      warning: "This trade is larger than the planned pool can support.",
    };
  }

  const amountInBeforeFee =
    (liquidityUsdx * amountAsset) / (reserveAsset - amountAsset);
  const amountIn = amountInBeforeFee / feeMultiplier;
  const expectedOut = amountIn / spotPrice;
  const impact = Math.max(0, 1 - amountAsset / expectedOut) * 100;

  return { impactPct: impact, warning: null };
}

function estimateSimulatedPrice({
  mode,
  amountAsset,
  liquidityUsdx,
  spotPrice,
  swapFeeBps,
}: {
  mode: AmmTradeMode;
  amountAsset: number;
  liquidityUsdx: number;
  spotPrice: number;
  swapFeeBps: number;
}) {
  if (liquidityUsdx <= 0 || spotPrice <= 0) return null;

  const reserveAsset = liquidityUsdx / spotPrice;
  if (amountAsset <= 0) return spotPrice;

  const feeMultiplier = 1 - swapFeeBps / 10000;
  if (feeMultiplier <= 0) return null;

  if (mode === "sale") {
    const amountInWithFee = amountAsset * feeMultiplier;
    const amountOut =
      (amountInWithFee * liquidityUsdx) / (reserveAsset + amountInWithFee);
    const nextReserveAsset = reserveAsset + amountAsset;
    const nextReserveUsdx = liquidityUsdx - amountOut;
    return nextReserveAsset > 0 && nextReserveUsdx > 0
      ? nextReserveUsdx / nextReserveAsset
      : null;
  }

  if (amountAsset >= reserveAsset) return null;

  const amountInBeforeFee =
    (liquidityUsdx * amountAsset) / (reserveAsset - amountAsset);
  const amountIn = amountInBeforeFee / feeMultiplier;
  const nextReserveAsset = reserveAsset - amountAsset;
  const nextReserveUsdx = liquidityUsdx + amountIn;
  return nextReserveAsset > 0 && nextReserveUsdx > 0
    ? nextReserveUsdx / nextReserveAsset
    : null;
}

function solveLiquidityForImpact({
  mode,
  amountAsset,
  targetImpactPct,
  spotPrice,
  swapFeeBps,
}: {
  mode: AmmTradeMode;
  amountAsset: number;
  targetImpactPct: number;
  spotPrice: number;
  swapFeeBps: number;
}): { liquidityUsdx: number | null; warning: string | null } {
  if (amountAsset <= 0 || spotPrice <= 0) {
    return {
      liquidityUsdx: null,
      warning: "Enter a trade size and launch price first.",
    };
  }

  const target = targetImpactPct / 100;
  const feeRate = swapFeeBps / 10000;
  const feeMultiplier = 1 - feeRate;

  if (target <= feeRate) {
    const feePct = formatEditableNumber(feeRate * 100, 2);
    return {
      liquidityUsdx: null,
      warning: `With the assumed ${feePct}% swap fee, impact cannot go below about ${feePct}%.`,
    };
  }

  if (target >= 1) {
    return {
      liquidityUsdx: null,
      warning: "Use a target impact below 100%.",
    };
  }

  const denominator = target - feeRate;
  const base = amountAsset * feeMultiplier * spotPrice;
  const liquidityUsdx =
    mode === "sale" ? ((1 - target) * base) / denominator : base / denominator;

  return {
    liquidityUsdx: Number.isFinite(liquidityUsdx) ? liquidityUsdx : null,
    warning: Number.isFinite(liquidityUsdx)
      ? null
      : "This simulation could not be estimated.",
  };
}

const ImageIcon = ({ className, src }: ImageIconProps) => (
  <img src={src} alt="" className={className} />
);

const BellIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-5-5.9V4a1 1 0 1 0-2 0v1.1A6 6 0 0 0 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0" />
  </svg>
);
const ChevronRightIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="m9 6 6 6-6 6" />
  </svg>
);

//prymary menu dashboard, exchange, staking
const PRIMARY_NAV = [
  {
    href: "/",
    label: "Dashboard",
    iconSrc: "/icons/dashboard.svg",
    activeIconSrc: "/icons/dashboard-active.svg",
    iconClassName: "h-[18px] w-[18px]",
    match: (p: string) => p === "/",
  },
  {
    href: "/exchange",
    label: "Exchange",
    iconSrc: "/icons/exchange.svg",
    activeIconSrc: "/icons/exchange-active.svg",
    iconClassName: "h-[18px] w-[18px]",
    match: (p: string) =>
      p.startsWith("/exchange") ||
      p.startsWith("/trade") ||
      p.startsWith("/cashout") ||
      p.startsWith("/swap"),
  },
  {
    href: "/staking",
    label: "Rewards",
    iconSrc: "/icons/staking.svg",
    activeIconSrc: "/icons/staking-active.svg",
    iconClassName: "h-5 w-5",
    match: (p: string) => p.startsWith("/staking"),
  },
] as const;

// Nav Mobile
export function MobilePrimaryNav({ className = "" }: { className?: string }) {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      aria-label="Primary navigation"
      className={`flex w-full overflow-hidden rounded-[6px] border border-[#D1D5DB] bg-white text-[#374151] shadow-sm sm:hidden ${className}`}
    >
      {PRIMARY_NAV.map((item, index) => {
        const active = item.match(pathname);
        const isLast = index === PRIMARY_NAV.length - 1;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={[
              "flex h-[38px] min-w-0 flex-1 items-center justify-center gap-2 px-2 transition-colors",
              !isLast ? "border-r border-[#D1D5DB]" : "",
              active
                ? "bg-[#B7E5FD] text-[#050A0C]"
                : "bg-white text-[#374151] hover:bg-[#F8FAFC]",
            ].join(" ")}
          >
            <ImageIcon
              src={active ? item.activeIconSrc : item.iconSrc}
              className="h-[14px] w-[14px] shrink-0"
            />
            <span className="truncate text-[12px] font-medium leading-none">
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}




interface AppShellProps {
  children: React.ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? "/";
  const { user, logout } = useAuth();

  const userInitial = useMemo(
    () => user?.name?.charAt(0).toUpperCase() ?? "U",
    [user?.name]
  );
  // Temporary Figma avatar asset; keep the authenticated user image branch ready.
  const showTemporaryAvatar = true;

  // ── Debug popover ───────────────────────────────────────────────
  // The bell currently has no notification feature, so we repurpose it
  // as a tiny test-utility menu. Used during dev to clear out stuck
  // Transak transactions while the webhook-reach issue is being
  // chased. TEMP: open to everyone for testing — re-add an
  // `isAdmin` gate before shipping (see `useAuth().user.roles`).
  const [bellOpen, setBellOpen] = useState(false);
  const [bellBusy, setBellBusy] = useState(false);
  const [bellMsg, setBellMsg] = useState<string | null>(null);
  // ── Launch Liquidity Planner ────────────────────────────────────
  // A pre-launch funding tool. All inputs are typed by the admin (no live
  // pool exists before launch), so the planner owns no async state — every
  // result is derived from these raw strings inside the modal.
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tradeDir, setTradeDir] = useState<AmmTradeMode>("purchase");
  const [usdxBudget, setUsdxBudget] = useState("");
  const [launchPrice, setLaunchPrice] = useState("");
  const [tradeSize, setTradeSize] = useState("");
  const [maxImpact, setMaxImpact] = useState("");
  const bellRef = useRef<HTMLDivElement>(null);

  const handleOpenPlanner = () => {
    setBellOpen(false);
    setBellMsg(null);
    setPlannerOpen(true);
  };

  // Sanitize-on-change for every numeric field (digits + single decimal).
  // Pass `max` to clamp the entered value (budget / price / trade size cap
  // at 100M); leave it off for uncapped fields like the impact percentage.
  const handleNumericChange =
    (setter: (value: string) => void, max?: number, decimals = 2) =>
    (value: string) => {
      const sanitized = sanitizeCalculatorNumber(value, decimals);
      if (max !== undefined) {
        const n = toFiniteNumber(sanitized);
        if (n !== null && n > max) {
          setter(String(max));
          return;
        }
      }
      setter(sanitized);
    };

  const handleResetPlanner = () => {
    setUsdxBudget("");
    setLaunchPrice("");
    setTradeSize("");
    setMaxImpact("");
  };

  useEffect(() => {
    if (!bellOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!bellRef.current?.contains(e.target as Node)) setBellOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBellOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [bellOpen]);
  const handleCancelAll = async () => {
    setBellBusy(true);
    setBellMsg(null);
    const res = await adminCancelAllPendingAction();
    setBellBusy(false);
    if (!res.success) {
      setBellMsg(`Failed: ${res.error}`);
      return;
    }
    const refundedSummary = `Cancelled ${res.trades} trade(s), refunded ${res.cashouts} cashout(s), and cancelled ${res.topUps} stable top-up(s).`;
    const skippedTotal =
      res.skipped.trades + res.skipped.cashouts + res.skipped.topUps;
    setBellMsg(
      skippedTotal > 0
        ? `${refundedSummary} Skipped ${skippedTotal} order(s) already past the safe-refund point — needs manual operator review.`
        : refundedSummary
    );
  };

  const handleRecover = async () => {
    setBellBusy(true);
    setBellMsg(null);
    const res = await adminRecoverBulkCancelledCashoutsAction();
    setBellBusy(false);
    if (!res.success) {
      setBellMsg(`Failed: ${res.error}`);
      return;
    }
    if (res.refunded === 0 && res.alreadyHandled === 0 && res.unsafeSkipped === 0) {
      setBellMsg("Nothing to recover — no cashouts were swallowed by the old bulk-cancel bug.");
      return;
    }
    const parts: string[] = [];
    if (res.refunded > 0) parts.push(`Refunded ${res.refunded} cashout(s)`);
    if (res.alreadyHandled > 0) parts.push(`${res.alreadyHandled} already recovered`);
    if (res.unsafeSkipped > 0) parts.push(`${res.unsafeSkipped} skipped (crypto already sent — needs manual review)`);
    setBellMsg(parts.join(" · ") + ".");
  };

  return (
    <div className="min-h-screen bg-[var(--ex-bg)] text-[var(--ex-text)]">
      {/* ── Top header ─────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-30 h-16 flex items-center px-4 lg:pl-0 lg:pr-6 text-white"
        style={{
          background:
            "linear-gradient(90deg, #5395B8 36%, #245878 69%, #050A0C 100%)",
        }}
      >
        {/* Brand + avatar */}
        <div className="flex shrink-0 items-center lg:w-[64px] lg:justify-center">
          <div className="relative h-11 w-11">
            <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-white/20">
              {showTemporaryAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/icons/user.png" alt={user?.name ?? "User"} className="h-full w-full object-contain" />
              ) : user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.image} alt={user?.name ?? "User"} className="h-full w-full object-cover" />
              ) : (
                <span className="text-sm font-semibold">{userInitial}</span>
              )}
            </div>
            <span className="absolute left-[32px] top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-[#D1D5DB] bg-white text-[var(--ex-brand-700)] shadow-sm">
              <ChevronRightIcon className="h-4 w-4" />
            </span>
          </div>
        </div>

        <Link href="/" className="ml-8 lg:ml-5 font-display text-lg font-semibold tracking-tight">
          Tokens Wallet
        </Link>

        <div className="flex-1" />

        {/* Pill nav */}
        <nav className="hidden sm:flex items-center overflow-hidden rounded-[8px] border border-[#D1D5DB] bg-white/95 text-[16px] font-medium shadow-sm">
          {PRIMARY_NAV.map((item, index) => {
            const active = item.match(pathname);
            const isLast = index === PRIMARY_NAV.length - 1;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex h-[36px] min-w-[140px] items-center justify-center gap-3 px-5 transition-colors",
                  !isLast ? "border-r border-[#D1D5DB]" : "",
                  active
                    ? "bg-[#B7E5FD] text-[#050A0C]"
                    : "bg-white text-[#374151] hover:bg-[#F8FAFC]",
                ].join(" ")}
              >
                <ImageIcon
                  src={active ? item.activeIconSrc : item.iconSrc}
                  className={`${item.iconClassName} shrink-0`}
                />
                <span className="text-[16px] leading-none">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div ref={bellRef} className="relative ml-3">
          <button
            type="button"
            aria-label="Debug tools"
            aria-haspopup="menu"
            aria-expanded={bellOpen}
            onClick={() => {
              setBellOpen((o) => !o);
              if (bellOpen) setBellMsg(null);
            }}
            className="w-10 h-10 rounded-full bg-white text-[var(--ex-brand-500)] hover:text-[var(--ex-brand-700)] shadow flex items-center justify-center transition-colors cursor-pointer"
          >
            <BellIcon className="w-5 h-5" />
          </button>
          {bellOpen && (
            <div
              role="menu"
              className="absolute right-0 top-12 z-40 w-[260px] rounded-lg border border-[var(--ex-border)] bg-white p-3 shadow-lg text-[var(--ex-text)]"
            >
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ex-text-muted)]">
                Debug · testing
              </p>
              <button
                type="button"
                onClick={handleCancelAll}
                disabled={bellBusy}
                className={
                  bellBusy
                    ? "w-full h-9 rounded-md bg-[#D8DEE7] text-[#738094] text-[13px] font-semibold cursor-not-allowed"
                    : "w-full h-9 rounded-md bg-rose-600 hover:bg-rose-500 text-white text-[13px] font-semibold transition-colors cursor-pointer"
                }
              >
                {bellBusy ? "Working…" : "Cancel all pending transactions"}
              </button>
              <button
                type="button"
                onClick={handleRecover}
                disabled={bellBusy}
                title="Refund users whose cashouts were swallowed by the old bulk-cancel bug (idempotent — safe to click twice)."
                className={
                  bellBusy
                    ? "mt-2 w-full h-9 rounded-md bg-[#D8DEE7] text-[#738094] text-[13px] font-semibold cursor-not-allowed"
                    : "mt-2 w-full h-9 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[13px] font-semibold transition-colors cursor-pointer"
                }
              >
                {bellBusy ? "Working…" : "Recover lost cashout refunds"}
              </button>
              <button
                type="button"
                onClick={handleOpenPlanner}
                disabled={bellBusy}
                className={
                  bellBusy
                    ? "mt-2 w-full h-9 rounded-md bg-[#D8DEE7] text-[#738094] text-[13px] font-semibold cursor-not-allowed"
                    : "mt-2 w-full h-9 rounded-md bg-[#0EA5E9] hover:bg-[#3EB7ED] text-white text-[13px] font-semibold transition-colors cursor-pointer"
                }
              >
                Launch Day Pool Planner
              </button>
              {bellMsg && (
                <p className="mt-2 text-[12px] text-[var(--ex-text-muted)]">
                  {bellMsg}
                </p>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex">
        {/* ── Left icon rail ───────────────────────────────────── */}
        <aside
          className="ex-shell__sidebar sticky top-16 h-[calc(100dvh-4rem)] w-[64px] shrink-0 flex-col items-center justify-between overflow-y-auto py-4 text-white/70"
          style={{
            background:
              "linear-gradient(180deg, #5395BB 0%, #245878 36%, #050A0C 100%)",
          }}
        >
          <nav className="ex-shell__rail-section ex-shell__rail-top flex flex-col items-center gap-1 pt-6">
            <SideRailDivider className="ex-shell__rail-divider--top mb-7" />
            {SIDE_RAIL_TOP.map((item) => (
              <SideRailItem
                key={item.src}
                {...item}
                active={"href" in item && item.href === "/" && pathname === "/"}
              />
            ))}
          </nav>

          <div className="ex-shell__rail-section ex-shell__rail-bottom flex flex-col items-center gap-1">
            <SideRailDivider className="ex-shell__rail-divider--bottom mb-5" />
            {SIDE_RAIL_BOTTOM.map((item) => (
              <SideRailItem
                key={item.src}
                {...item}
                onClick={item.src === "/SideBar/17Log-out.svg" ? () => void logout() : undefined}
              />
            ))}
            <div className="ex-shell__rail-item ex-shell__rail-mark mt-5 flex h-9 w-10 items-center justify-center" aria-hidden>
              <SideRailGlyph src="/SideBar/18Logo.svg" className="h-[33px] w-[37px]" />
            </div>
          </div>
        </aside>

        {/* ── Main canvas ──────────────────────────────────────── */}
        <main className="flex-1 min-w-0 overflow-x-clip min-h-[calc(100vh-64px)] flex flex-col">
          <div className="w-full max-w-[1200px] xl:max-w-[1440px] 2xl:max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 2xl:px-12 py-6 lg:py-8 flex-1">
            {children}
          </div>
          <footer className="w-full max-w-[1200px] xl:max-w-[1440px] 2xl:max-w-[1536px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 2xl:px-12 pb-6 text-xs text-[var(--ex-text-subtle)]">
            © {new Date().getFullYear()} · Compliant Token Exchange
          </footer>
        </main>
      </div>
      {plannerOpen && (
        <LaunchLiquidityPlannerModal
          tradeDir={tradeDir}
          usdxBudget={usdxBudget}
          launchPrice={launchPrice}
          tradeSize={tradeSize}
          maxImpact={maxImpact}
          onTradeDirChange={setTradeDir}
          onBudgetChange={handleNumericChange(setUsdxBudget, FIELD_MAX)}
          onPriceChange={handleNumericChange(setLaunchPrice, FIELD_MAX, 6)}
          onTradeSizeChange={handleNumericChange(setTradeSize, FIELD_MAX)}
          onMaxImpactChange={handleNumericChange(setMaxImpact, 100)}
          onReset={handleResetPlanner}
          onClose={() => setPlannerOpen(false)}
          onOpenHelp={() => setHelpOpen(true)}
        />
      )}
      {helpOpen && <AmmExplanationModal onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

type LaunchLiquidityPlannerModalProps = {
  tradeDir: AmmTradeMode;
  usdxBudget: string;
  launchPrice: string;
  tradeSize: string;
  maxImpact: string;
  onTradeDirChange: (mode: AmmTradeMode) => void;
  onBudgetChange: (value: string) => void;
  onPriceChange: (value: string) => void;
  onTradeSizeChange: (value: string) => void;
  onMaxImpactChange: (value: string) => void;
  onReset: () => void;
  onClose: () => void;
  onOpenHelp: () => void;
};

function LaunchLiquidityPlannerModal({
  tradeDir,
  usdxBudget,
  launchPrice,
  tradeSize,
  maxImpact,
  onTradeDirChange,
  onBudgetChange,
  onPriceChange,
  onTradeSizeChange,
  onMaxImpactChange,
  onReset,
  onClose,
  onOpenHelp,
}: LaunchLiquidityPlannerModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const budget = toFiniteNumber(usdxBudget);
  const price = toFiniteNumber(launchPrice);
  const trade = toFiniteNumber(tradeSize);
  const target = toFiniteNumber(maxImpact);

  const hasBudget = budget !== null && budget > 0;
  // Step 1 is the prerequisite for everything downstream: both the budget and
  // the launch price must be valid before a trade or limit can be evaluated.
  const step1Ready = hasBudget && price !== null && price > 0;
  const hasTrade = trade !== null && trade > 0;

  // Funding deposit — the headline result. Full null-checks live inside each
  // expression so TS narrows budget/price/trade to `number` in the branch.
  const platRequired =
    budget !== null && budget > 0 && price !== null && price > 0
      ? budget / price
      : null;
  // Both sides hold equal value, so total = exactly 2× the USDX budget.
  const totalPoolValue = budget !== null && budget > 0 ? budget * 2 : null;

  // Trade-impact estimates (shared constant-product math).
  const impact =
    budget !== null && budget > 0 && price !== null && price > 0 && trade !== null && trade > 0
      ? estimateAmmImpact({
          mode: tradeDir,
          amountAsset: trade,
          liquidityUsdx: budget,
          spotPrice: price,
          swapFeeBps: LAUNCH_SWAP_FEE_BPS,
        })
      : null;
  const priceAfter =
    budget !== null && budget > 0 && price !== null && price > 0 && trade !== null && trade > 0
      ? estimateSimulatedPrice({
          mode: tradeDir,
          amountAsset: trade,
          liquidityUsdx: budget,
          spotPrice: price,
          swapFeeBps: LAUNCH_SWAP_FEE_BPS,
        })
      : null;

  // Max-impact solver → required USDX side to keep `trade` under `target`%.
  const required =
    price !== null && price > 0 && trade !== null && trade > 0 && target !== null && target > 0
      ? solveLiquidityForImpact({
          mode: tradeDir,
          amountAsset: trade,
          targetImpactPct: target,
          spotPrice: price,
          swapFeeBps: LAUNCH_SWAP_FEE_BPS,
        })
      : null;
  const budgetCoversTarget =
    required && required.liquidityUsdx != null && budget !== null
      ? budget >= required.liquidityUsdx
      : null;
  const impactWithinTarget =
    impact?.impactPct != null && target !== null && target > 0
      ? impact.impactPct <= target
      : null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/40 px-4 py-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-planner-title"
        className="max-h-[90vh] w-full max-w-[640px] overflow-y-auto rounded-xl border border-[var(--ex-border)] bg-white p-6 text-[var(--ex-text)] shadow-xl sm:p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2
              id="launch-planner-title"
              className="font-display text-[22px] font-semibold leading-[28px] text-[#111827]"
            >
              Launch Day Pool Planner
            </h2>
            <p className="mt-1 text-[13px] leading-[18px] text-[#6B7280]">
              Plan how much USDX and PLAT to place in the pool before
              trading starts.
            </p>
            <button
              type="button"
              onClick={onOpenHelp}
              className="mt-2 text-left text-[13px] font-semibold text-[#0284C7] underline underline-offset-2 hover:text-[#3EB7ED]"
            >
              What is this pool and how does it work?
            </button>
          </div>
          <ModalCloseButton onClick={onClose} label="Close launch planner" />
        </div>

        {/* Launch funding inputs */}
        <h3 className="mb-3 font-display text-[16px] font-semibold leading-[22px] text-[#111827]">
          1 — Set your launch plan
        </h3>
        <p className="mb-3 text-[12px] leading-[18px] text-[#6B7280]">
          Tell us your USDX budget and launch price. We&apos;ll calculate the
          PLAT side for you.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <CalculatorField
            label="How much USDX do you want  in the pool?"
            value={usdxBudget}
            suffix="USDX"
            placeholder="15,000"
            disabled={false}
            onChange={onBudgetChange}
          />
          <CalculatorField
            label="What launch price do you want for PLAT?"
            value={launchPrice}
            suffix="USDX"
            placeholder="0.74"
            disabled={false}
            onChange={onPriceChange}
          />
        </div>

        {/* Compact launch deposit summary, right under the funding inputs */}
        <div className="mt-3 rounded-[10px] border border-[#BAE6FD] bg-gradient-to-br from-[#F0F9FF] to-[#ECFDF5] px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0EA5E9]">
            Your launch pool will need
          </p>
          {platRequired !== null && budget !== null && totalPoolValue !== null ? (
            <>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-[14px] font-semibold text-[#065F46]">
                  {formatDisplayNumber(budget, 2)} USDX
                </span>
                <span className="text-[14px] font-light text-[#9AA7B8]">+</span>
                <span className="text-[14px] font-semibold text-[#1E3A8A]">
                  {formatDisplayNumber(platRequired, 0)} PLAT
                </span>
              </div>
              <p className="mt-2 text-[12px] leading-[18px] text-[#0C4A6E]">
                That means both sides have the same value at launch:{" "}
                {formatDisplayNumber(budget, 2)} USDX on one side, and{" "}
                {formatDisplayNumber(budget, 2)} USDX worth of PLAT on the
                other.
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-[13px] leading-[18px] text-[#0C4A6E]">
              {!hasBudget ? "Enter a USDX budget." : "Enter a valid launch price."}
            </p>
          )}
        </div>

        {/* ── Trade impact test ── */}
        <div className="mt-5 border-t border-[#E2E8F0] pt-4">
          <h3 className="font-display text-[16px] font-semibold leading-[22px] text-[#111827]">
            2 — See how one trade would move the price
          </h3>
          <p className="mt-1 text-[12px] leading-[18px] text-[#6B7280]">
            Use this to see how much a trade could move the price when trading starts.
          </p>

          <div className="mt-3 grid items-start gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-[12px] font-semibold text-[#6B7280]">
                What kind of trade do you want to test?
              </span>
              <SegmentedControl
                ariaLabel="Trade direction"
                size="sm"
                value={tradeDir}
                onChange={onTradeDirChange}
                options={[
                  { value: "purchase", label: "PLAT Purchase" },
                  { value: "sale", label: "PLAT Sale" },
                ]}
              />
            </div>
            <CalculatorField
              label="How many PLAT tokens are being traded?"
              value={tradeSize}
              suffix="PLAT"
              placeholder="500"
              disabled={false}
              onChange={onTradeSizeChange}
            />
          </div>

          {/* Prerequisite hint: a trade was entered but Step 1 isn't complete */}
          {hasTrade && !step1Ready && (
            <p className="mt-3 text-[12px] leading-[18px] text-amber-700">
              Complete Step 1 first — enter a USDX budget and a PLAT price
              to simulate this trade.
            </p>
          )}

          {/* What a trade does at the planned pool */}
          {impact && (
            <div className="mt-4 rounded-[10px] border border-[#BAE6FD] bg-[#F0F9FF] px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0EA5E9]">
                Trade test result
              </p>

              {impact.warning ? (
                <p className="mt-2 text-[13px] leading-[19px] text-amber-700">
                  {impact.warning}
                </p>
              ) : impact.impactPct != null && price !== null && trade !== null ? (
                <>
                  <p className="mt-2 text-[13px] leading-[19px] text-[#0C4A6E]">
                    If someone {tradeDir === "purchase" ? "buys" : "sells"}{" "}
                    {formatDisplayNumber(trade, 0)} PLAT, the pool
                    estimates:
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <SummaryItem
                      label="Price impact"
                      value={`${formatDisplayNumber(impact.impactPct, 2)}%`}
                    />
                    <SummaryItem
                      label="Pool price after trade"
                      value={
                        priceAfter != null
                          ? `$${formatEditableNumber(price, 4)} → $${formatEditableNumber(priceAfter, 4)}`
                          : "—"
                      }
                    />
                  </div>
                  <p className="mt-3 text-[12px] leading-[18px] text-[#6B7280]">
                    {target === null || target <= 0
                      ? "Smaller price impact is better. It means the pool can absorb the trade with less movement."
                      : impactWithinTarget === true
                      ? "This trade stays within your comfort zone. Your launch pool is deep enough for this trade size."
                      : "This trade would move the price more than your comfort zone. Consider adding more USDX and matching PLAT before launch."}
                  </p>
                </>
              ) : null}
            </div>
          )}
        </div>

        {/* ── Step 3: optional acceptable-impact check ── */}
        <div className="mt-5 border-t border-[#E2E8F0] pt-4">
          <h3 className="font-display text-[16px] font-semibold leading-[22px] text-[#111827]">
            3 — Choose your comfort zone
          </h3>
          <p className="mt-1 text-[12px] leading-[18px] text-[#6B7280]">
            Set the biggest price movement you&apos;d be comfortable with for
            the trade above. We&apos;ll tell you if your launch pool is enough.
          </p>

          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <CalculatorField
              label="Maximum price movement you're okay with"
              value={maxImpact}
              suffix="%"
              placeholder="2.5"
              disabled={false}
              onChange={onMaxImpactChange}
            />
            <div aria-hidden />
          </div>

          {/* Prerequisite hint: a limit was entered but upstream steps aren't ready */}
          {target !== null && target > 0 && !(step1Ready && hasTrade) && (
            <p className="mt-3 text-[12px] leading-[18px] text-amber-700">
              {!step1Ready
                ? "Complete Step 1 first — enter a USDX budget and a PLAT price."
                : "Enter a trade size in Step 2 to check it against your price movement limit."}
            </p>
          )}

          {required && (
            <div
              className={
                "mt-4 rounded-[10px] border px-4 py-3.5 " +
                (required.warning
                  ? "border-amber-200 bg-amber-50"
                  : budgetCoversTarget === true
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-200 bg-amber-50")
              }
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#6B7280]">
                Comfort zone check
              </p>

              {required.warning ? (
                <p className="mt-1.5 text-[13px] leading-[19px] text-amber-700">
                  {required.warning}
                </p>
              ) : budgetCoversTarget === true && required.liquidityUsdx != null ? (
                <>
                  {/* Your planned pool → required pool (surplus) */}
                  <div className="mt-3 flex flex-wrap items-stretch gap-3">
                    <div className="flex-1 min-w-[150px] rounded-[10px] border border-emerald-300 bg-white px-4 py-3">
                      <p className="text-[11px] font-medium text-emerald-700">
                        Your planned USDX side
                      </p>
                      <p className="mt-0.5 text-[18px] font-semibold text-[#111827]">
                        {formatDisplayNumber(budget ?? 0, 2)}{" "}
                        <span className="text-[12px] font-medium text-[#6B7280]">
                          USDX
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center justify-center text-[20px] text-[#9AA7B8]">
                      →
                    </div>
                    <div className="flex-1 min-w-[150px] rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-3">
                      <p className="text-[11px] font-medium text-[#6B7280]">
                        USDX side needed
                      </p>
                      <p className="mt-0.5 text-[18px] font-semibold text-[#111827]">
                        {formatDisplayNumber(required.liquidityUsdx, 2)}{" "}
                        <span className="text-[12px] font-medium text-[#6B7280]">
                          USDX
                        </span>
                      </p>
                    </div>
                  </div>

                  <p className="mt-3 text-[13px] font-semibold leading-[19px] text-emerald-800">
                    Good news — your plan is more than enough.
                  </p>
                  <p className="mt-1 text-[13px] leading-[19px] text-emerald-800">
                    For a {formatDisplayNumber(trade ?? 0, 0)} PLAT{" "}
                    {tradeDir === "purchase" ? "buy" : "sell"}, you only need
                    about {formatDisplayNumber(required.liquidityUsdx, 2)}{" "}
                    USDX on the stablecoin side. Your plan has{" "}
                    {formatDisplayNumber(budget ?? 0, 2)} USDX, so you have
                    enough.
                  </p>
                </>
              ) : budgetCoversTarget === true ? (
                <p className="mt-1.5 text-[13px] leading-[19px] text-emerald-700">
                  Good news — your planned pool is deep enough for a{" "}
                  {formatDisplayNumber(trade ?? 0, 0)} PLAT{" "}
                  {tradeDir === "purchase" ? "buy" : "sell"} under{" "}
                  {formatDisplayNumber(target ?? 0, 2)}% impact.
                </p>
              ) : (
                required.liquidityUsdx != null && (
                  <>
                    {/* Current pool → required pool */}
                    <div className="mt-3 flex flex-wrap items-stretch gap-3">
                      <div className="flex-1 min-w-[150px] rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-3">
                        <p className="text-[11px] font-medium text-[#6B7280]">
                          Your planned USDX side
                        </p>
                        <p className="mt-0.5 text-[18px] font-semibold text-[#111827]">
                          {formatDisplayNumber(budget ?? 0, 2)}{" "}
                          <span className="text-[12px] font-medium text-[#6B7280]">
                            USDX
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center justify-center text-[20px] text-[#9AA7B8]">
                        →
                      </div>
                      <div className="flex-1 min-w-[150px] rounded-[10px] border border-amber-300 bg-white px-4 py-3">
                        <p className="text-[11px] font-medium text-amber-700">
                          USDX side needed
                        </p>
                        <p className="mt-0.5 text-[18px] font-semibold text-[#111827]">
                          {formatDisplayNumber(required.liquidityUsdx, 2)}{" "}
                          <span className="text-[12px] font-medium text-[#6B7280]">
                            USDX
                          </span>
                        </p>
                      </div>
                    </div>

                    <p className="mt-3 text-[13px] font-semibold leading-[19px] text-amber-800">
                      Your pool needs more cushion for this limit.
                    </p>
                    <p className="mt-1 text-[13px] leading-[19px] text-amber-800">
                      To keep a {formatDisplayNumber(trade ?? 0, 0)} PLAT{" "}
                      {tradeDir === "purchase" ? "buy" : "sell"} under{" "}
                      {formatDisplayNumber(target ?? 0, 2)}% price movement, the
                      USDX side should be about{" "}
                      {formatDisplayNumber(required.liquidityUsdx, 2)} USDX.
                    </p>
                  </>
                )
              )}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onReset}
            className="text-[12px] font-semibold text-[#0284C7] underline underline-offset-2 transition-colors hover:text-[#3EB7ED]"
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
  size = "md",
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex w-full rounded-md border border-[#DDE7EF] bg-[#F3F6FA] p-1"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={
              (active
                ? "bg-white text-[#0284C7] shadow-sm "
                : "bg-transparent text-[#6B7280] hover:text-[#111827] ") +
              (size === "sm" ? "h-[34px] text-[12px] " : "h-9 text-[13px] ") +
              "flex-1 rounded-[6px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function CalculatorField({
  label,
  helperText,
  value,
  suffix,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  helperText?: string;
  value: string;
  suffix: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-[#6B7280]">
        {label}
      </span>
      <span className="flex h-11 items-center rounded-md border border-[#DDE7EF] bg-white px-3 focus-within:border-[#0EA5E9] focus-within:ring-2 focus-within:ring-[#BAE6FD]">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] font-semibold text-[#111827] outline-none placeholder:text-[#9AA7B8] disabled:cursor-not-allowed disabled:text-[#738094]"
        />
        <span className="ml-2 shrink-0 text-[12px] font-semibold text-[#6B7280]">
          {suffix}
        </span>
      </span>
      {helperText && (
        <span className="mt-1.5 block text-[11px] leading-[16px] text-[#6B7280]">
          {helperText}
        </span>
      )}
    </label>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-[#6B7280]">{label}</p>
      <p className="mt-1 text-[14px] font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function AmmExplanationModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[#111827]/45 px-4 py-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How the launch liquidity pool works"
        className="max-h-[90vh] w-full max-w-[840px] overflow-y-auto rounded-xl border border-[var(--ex-border)] bg-white p-4 text-[var(--ex-text)] shadow-xl sm:p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-end">
          <ModalCloseButton onClick={onClose} label="Close pool guide" />
        </div>

        <div className="space-y-4 text-sm leading-relaxed text-[var(--ex-text)]">
          <h2 className="text-2xl font-semibold">What is this pool and how does it work?</h2>
          <section className="rounded-[10px] border border-[var(--ex-border)] p-4">
            <h3 className="mb-1 font-semibold">The pool has two sides</h3>
            <p>
              PLAT and USDX sit on opposite sides of the pool, and the balance between them sets
              the price. At launch, fund both sides with the same <em>value</em>, not the same token
              count.
            </p>
          </section>
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-[10px] border border-[var(--ex-border)] p-4">
              <h3 className="mb-1 font-semibold">Buys push the price up</h3>
              <p>Buying adds USDX and removes PLAT, which makes PLAT more expensive.</p>
            </div>
            <div className="rounded-[10px] border border-[var(--ex-border)] p-4">
              <h3 className="mb-1 font-semibold">Sells push the price down</h3>
              <p>Selling adds PLAT and removes USDX, which makes PLAT cheaper.</p>
            </div>
          </section>
          <section className="rounded-[10px] border border-[var(--ex-border)] p-4">
            <h3 className="mb-1 font-semibold">More pool funding means smoother trading</h3>
            <p>
              A deeper launch pool lets buyers and sellers trade without moving the price too much.
            </p>
          </section>
          <section className="rounded-[10px] bg-[var(--ex-surface-muted)] p-4">
            <h3 className="mb-2 font-semibold">How to use this planner</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li><strong>Set your launch plan:</strong> how much USDX goes in the pool and the launch price for PLAT.</li>
              <li><strong>Simulate a trade:</strong> see how a PLAT purchase or sale moves the price.</li>
              <li><strong>Plan for smooth trading:</strong> check the pool is deep enough to avoid large price moves.</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

const SIDE_RAIL_TOP = [
  { src: "/SideBar/1house.svg", label: "Home" },
  { src: "/SideBar/2calendar.svg", label: "Calendar" },
  { src: "/SideBar/3chats.svg", label: "Messages" },
  { src: "/SideBar/4users.svg", label: "Contacts" },
  { src: "/SideBar/5wallet.svg", label: "Wallet", href: "/" },
  { src: "/SideBar/6chart.svg", label: "Insights" },
  { src: "/SideBar/7rocket.svg", label: "Launch" },
  { src: "/SideBar/8church.svg", label: "Organization" },
  { src: "/SideBar/9Book.svg", label: "Documents" },
  { src: "/SideBar/10Globe.svg", label: "Network" },
  { src: "/SideBar/11Store.svg", label: "Store" },
  { src: "/SideBar/12GraduationCap.svg", label: "Learning" },
  { src: "/SideBar/13Brain.svg", label: "Knowledge" },
  { src: "/SideBar/14Ticket.svg", label: "Tickets" },
] as const;

const SIDE_RAIL_BOTTOM = [
  { src: "/SideBar/15Settings.svg", label: "Settings" },
  { src: "/SideBar/16Info.svg", label: "Information" },
  { src: "/SideBar/17Log-out.svg", label: "Log out" },
] as const;

interface SideRailItemProps {
  src: string;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
}

function SideRailDivider({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`ex-shell__rail-divider block w-[42.2px] shrink-0 border-t-[0.3px] border-white opacity-[0.65] ${className}`}
    />
  );
}

function SideRailItem({ src, label, href, onClick, active = false }: SideRailItemProps) {
  const className = active
    ? "ex-shell__rail-item flex h-10 w-10 items-center justify-center rounded-[6px] bg-[#1E475C]"
    : "ex-shell__rail-item flex h-9 w-10 items-center justify-center rounded-[6px]";
  const contents = <SideRailGlyph src={src} active={active} />;

  if (href) {
    return (
      <Link href={href} aria-label={label} title={label} aria-current={active ? "page" : undefined} className={className}>
        {contents}
      </Link>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`${className} ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      {contents}
    </button>
  );
}

function SideRailGlyph({
  src,
  active = false,
  className = "h-[16px] w-[16px]",
}: {
  src: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`${className} block ${active ? "bg-[#ACE5FF]" : "bg-white"}`}
      style={{
        WebkitMaskImage: `url("${src}")`,
        maskImage: `url("${src}")`,
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
