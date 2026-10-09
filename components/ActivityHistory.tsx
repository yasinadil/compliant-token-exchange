// components/ActivityHistory.tsx
"use client";

// Shared activity-feed primitives used across Dashboard / Exchange /
// Staking. Centralized here so the inline table on the dashboard, the
// "See all" modal on each page, and any future surface (history page,
// admin tools) share the same row design, badges, status pills, and
// sticky-header scrolling behavior.
//
// Exports:
//   • <ActivityTable>            — the table with sticky header + rows
//   • <TransactionHistoryModal>  — the modal shell that wraps the table
//                                  in a scrollable 8-row-height window
//                                  with a sleek custom scrollbar
//
// Both expect rows in `DashboardActivity` shape (from
// `app/actions/dashboard.ts`) so the same renderer powers every surface.

import type {
  DashboardActivity,
  DashboardActivityKind,
} from "@/app/actions/dashboard";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ModalCloseButton } from "@/components/ModalCloseButton";
import { ActivityTableSkeleton } from "@/components/Skeletons";

// ─────────────────────────────────────────────────────────────────────
// Table — used inline (dashboard) and inside the modal (every page).
// ─────────────────────────────────────────────────────────────────────

export function ActivityTable({
  rows,
  loading,
  className = "overflow-hidden",
}: {
  rows: DashboardActivity[];
  loading: boolean;
  className?: string;
}) {
  return (
    <div className={`ex-card ${className}`}>
      {/* `sticky top-0` keeps this header visible when the table is
          rendered inside a scrolling ancestor (e.g. the modal). It's
          a no-op for the inline dashboard table since that has no
          scrolling ancestor.
          5 columns: Action | Paid | Received | Date | Status. Paid +
          Received are separate so the user sees both sides of a Buy /
          Sell / Swap at a glance instead of having to remember the
          other half. One-sided rows (stake / rewards) show "—" in the
          column that doesn't apply. */}
      <div className="sticky top-0 z-10 isolate hidden md:grid activity-grid bg-[#E5E7EB] px-5 py-[20px] text-[16px] font-semibold text-[#374151] before:absolute before:inset-0 before:-z-10 before:rounded-t-[16px] before:bg-[var(--ex-surface-muted)] before:border-b before:border-[var(--ex-border)]">
        {/* All 5 headers left-aligned to match the left-aligned cell
            content below — each column reads top-to-bottom along its
            left edge. */}
        <div>Action</div>
        <div>Paid</div>
        <div>Received</div>
        <div>Date</div>
        <div>Status</div>
      </div>
      <div>
        {loading ? (
          <ActivityRowsSkeleton />
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-[var(--ex-text-muted)]">
            No transactions yet.
          </div>
        ) : (
          rows.map((r) => <ActivityRow key={r.id} row={r} />)
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Modal — the "Transaction history" overlay opened by every "See all".
// ─────────────────────────────────────────────────────────────────────

export function CompactActivityList({
  rows,
}: {
  rows: DashboardActivity[];
}) {
  return (
    <div className="ex-card overflow-hidden">
      {rows.map((row) => (
        <CompactActivityRow key={row.id} row={row} />
      ))}
    </div>
  );
}

export function CompactActivityEmptyState() {
  return (
    <div className="ex-card flex min-h-[90px] items-center justify-center gap-3 px-4 py-6 sm:gap-5 sm:px-6 sm:py-7">
      <img
        src="/icons/no-recent-activity.svg"
        alt=""
        aria-hidden
        className="h-[54px] w-[54px] shrink-0 object-contain opacity-80"
      />
      <p className="font-sans text-[16px] font-semibold leading-tight text-[rgba(17,24,39,0.4)] sm:text-[24px] sm:leading-[32px]">
        No recent activity
      </p>
    </div>
  );
}

export function TransactionHistoryModal({
  rows,
  loading,
  onClose,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: {
  rows: DashboardActivity[];
  loading: boolean;
  onClose: () => void;
  /**
   * Optional pagination hook. When `hasMore` is true AND this callback
   * is provided, a "Load more" button renders at the bottom of the
   * scroll area. Click → caller fetches the next page and appends to
   * `rows`. The button shows a disabled "Loading…" state while
   * `loadingMore` is true.
   *
   * Surfaces without pagination (or that haven't wired it up yet) can
   * just omit these props — the button never renders.
   */
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
      <div className="relative w-full max-w-[1280px] flex flex-col rounded-[6px] bg-[#E5E7EB] px-4 py-6 sm:px-12 sm:py-10 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-[24px] font-semibold text-[#4B5563]">
            Transaction history
          </h2>
          {/* Shared close button so the "See all" modal matches the
              Exchange review modals (Buy / Sell / Convert) and the tutorial.
              `size="lg"` = the same 44px target; positioned in the corner
              via the passed `className`. */}
          {/* Horizontally centered over the custom scrollbar: the scroll
              area sits inside the modal's sm:px-12 padding and its 9px rail
              is at right-0, so its center is ~52px from the modal edge. A
              44px button at sm:right-8 (32px) lands its center there. Mobile
              keeps right-6 (padding is only px-4 there). */}
          <ModalCloseButton
            onClick={onClose}
            label="Close transaction history"
            size="lg"
            className="absolute right-6 top-6 sm:right-8"
          />
        </div>

        {/* Scrollable list — fixed height fitting roughly 8 rows + the
            sticky header (≈540px). Anything beyond row 8 scrolls inside
            this container; the table header stays pinned at the top.
            The "Load more" button sits INSIDE the scroll area so it
            anchors to the natural end of the list — the user scrolls
            to the bottom to find it. */}
        <ActivityModalScrollArea>
          {/* Desktop (md+): the full 5-column table. */}
          <div className="hidden md:block">
            <ActivityTable
              rows={rows}
              loading={loading}
              className="overflow-visible rounded-[16px]"
            />
          </div>
          {/* Mobile (< md): the same compact card rows used by the inline
              "recent activity" lists on Dashboard / Exchange / Rewards, so
              the modal matches the rest of the mobile UI instead of
              cramming the desktop grid into a narrow viewport. */}
          <div className="md:hidden">
            {loading ? (
              <ActivityTableSkeleton rows={6} />
            ) : rows.length === 0 ? (
              <CompactActivityEmptyState />
            ) : (
              <CompactActivityList rows={rows} />
            )}
          </div>
          {onLoadMore && hasMore && !loading && (
            <div className="flex justify-center pt-5 pb-2">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="text-xs font-medium px-5 py-2 rounded-[4px] text-white bg-[#0EA5E9] hover:bg-[#0284C7] transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </ActivityModalScrollArea>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Internal — row, badge, status pill, skeleton, formatters.
// ─────────────────────────────────────────────────────────────────────

function ActivityModalScrollArea({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
  } | null>(null);
  const [thumb, setThumb] = useState({
    height: 0,
    top: 0,
    visible: false,
  });

  const syncThumb = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const { clientHeight, scrollHeight, scrollTop } = viewport;
    const maxScroll = scrollHeight - clientHeight;
    const visible = maxScroll > 1;
    const height = visible
      ? Math.max(48, (clientHeight * clientHeight) / scrollHeight)
      : 0;
    const travel = clientHeight - height;
    const top = visible ? (scrollTop / maxScroll) * travel : 0;

    setThumb((current) =>
      current.height === height &&
      current.top === top &&
      current.visible === visible
        ? current
        : { height, top, visible }
    );
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const resizeObserver = new ResizeObserver(syncThumb);
    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) {
      resizeObserver.observe(viewport.firstElementChild);
    }

    return () => resizeObserver.disconnect();
  }, [syncThumb]);

  const updateScrollFromThumbDelta = (
    deltaY: number,
    initialScrollTop: number
  ) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const travel = viewport.clientHeight - thumb.height;
    if (travel <= 0) return;

    viewport.scrollTop = initialScrollTop + (deltaY / travel) * maxScroll;
  };

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateScrollFromThumbDelta(event.clientY - drag.startY, drag.startScrollTop);
  };

  const handleThumbPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleRailPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    const viewport = viewportRef.current;
    const rail = railRef.current;
    if (!viewport || !rail) return;

    const travel = viewport.clientHeight - thumb.height;
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const clickTop =
      event.clientY - rail.getBoundingClientRect().top - thumb.height / 2;
    const nextTop = Math.max(0, Math.min(travel, clickTop));
    viewport.scrollTop = travel > 0 ? (nextTop / travel) * maxScroll : 0;
  };

  return (
    <div className="relative">
      <div
        ref={viewportRef}
        onScroll={syncThumb}
        className="activity-modal-scroll max-h-[540px] overflow-y-auto pr-7"
      >
        {children}
      </div>
      {thumb.visible && (
        <div
          ref={railRef}
          aria-hidden="true"
          onPointerDown={handleRailPointerDown}
          className="absolute inset-y-0 right-0 w-[9px] rounded-[10px] bg-[#D2D2D2]"
        >
          <div
            onPointerDown={handleThumbPointerDown}
            onPointerMove={handleThumbPointerMove}
            onPointerUp={handleThumbPointerUp}
            onPointerCancel={handleThumbPointerUp}
            className="absolute left-0 right-0 cursor-pointer touch-none select-none rounded-[10px] bg-[#0EA5E9] transition-colors hover:bg-[#0284C7]"
            style={{
              height: thumb.height,
              transform: `translateY(${thumb.top}px)`,
            }}
          />
        </div>
      )}
      <style jsx>{`
        .activity-modal-scroll {
          scrollbar-width: none;
        }
        .activity-modal-scroll::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
      `}</style>
    </div>
  );
}

function ActivityRow({ row }: { row: DashboardActivity }) {
  return (
    <div className="grid grid-cols-1 activity-grid items-center gap-2 md:gap-0 px-5 py-3 border-b border-[var(--ex-border)] last:border-b-0 hover:bg-[var(--ex-surface-muted)] transition-colors">
      {/* Action — left-aligned content under a centered header. The
          badge + title anchor to the left edge of the column track. */}
      <div className="flex min-w-0 items-center gap-3">
        <KindBadge kind={row.kind} />
        {/* Nested flex so the title↔icon spacing (gap-1.5) is tighter
            than the badge↔title spacing (gap-3 from the parent). */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-sm font-medium text-[var(--ex-text)] truncate">
            {row.title}
          </span>
          {row.txHash && row.txChain && (
            <a
              href={`${
                row.txChain === "base-sepolia"
                  ? "https://sepolia.basescan.org"
                  : "https://basescan.org"
              }/tx/${row.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View transaction on BaseScan"
              title="View transaction on BaseScan"
              className="shrink-0 text-[var(--ex-text-subtle)] hover:text-[#0EA5E9] transition-colors"
            >
              <ExternalLinkIcon />
            </a>
          )}
        </div>
      </div>

      {/* Paid column — always muted grey because outflow is purely
          directional, never a "loss" that deserves a red/colored tone.
          Falls back to an em-dash for inflow-only rows. */}
      <AmountCell
        label={row.paidLabel}
        className="text-sm font-normal text-[#6B7280]"
      />

      {/* Received column — colored by amountTone (green for gains,
          slate for neutral movements, rose for losses). Em-dash for
          outflow-only rows. */}
      <AmountCell
        label={row.receivedLabel}
        className={`text-sm font-normal ${amountToneClass(row.amountTone)}`}
      />

      {/* Date cell — relative phrasing for recent items, falls back to
          DD Mon (year if not current). Tooltip carries the full ISO
          timestamp for power users who need exact precision. */}
      <div
        className="text-sm text-[var(--ex-text-muted)]"
        title={fullDateTitle(row.createdAt)}
      >
        {formatDate(row.createdAt)}
      </div>

      {/* Status cell — pill only. The failure-reason subtitle that
          used to render below was removed at design's request; the
          data is still flowing on `row.failureReason` if it needs to
          come back. */}
      <div className="min-w-0 flex flex-col items-start">
        <StatusPill status={row.status} />
      </div>
    </div>
  );
}

/**
 * Renders an amount cell with two stacked spans:
 *   • Mobile (< md): full-precision string ("1,234.56 PLAT").
 *   • Desktop (md+): compact for ≥10k ("1.23k PLAT"), full otherwise.
 *
 * The dual render avoids hydration mismatches that a window/match-media
 * hook would create, and avoids the flash a useEffect-after-mount
 * approach would have. Only one span paints at a time thanks to
 * Tailwind's `md:hidden` / `hidden md:inline`.
 *
 * The desktop span carries a `title` tooltip with the full-precision
 * value, but only when compact actually shortened the string — no
 * point tooltipping "5.00 PLAT" with itself.
 *
 * `label=null` (one-sided rows) renders an em-dash placeholder so the
 * column never looks empty.
 */
function CompactActivityRow({ row }: { row: DashboardActivity }) {
  const paid = row.paidLabel
    ? formatActivityAmount(row.paidLabel, { compact: false })
    : null;
  const received = row.receivedLabel
    ? formatActivityAmount(row.receivedLabel, { compact: false })
    : null;

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-[#E5E7EB] px-3 min-h-[88px] last:border-b-0 sm:gap-4 sm:px-5 sm:min-h-[96px]">
      <KindBadge kind={row.kind} />

      <div className="min-w-0 flex-1 py-3">
        <p className="truncate font-display text-[13px] font-semibold text-[#111827] sm:text-[14px]">
          {row.title}
        </p>
        <p className="-mt-0.5 flex min-w-0 items-center gap-1 whitespace-nowrap text-[12px] text-[#6B7280]">
          <CompactStatusText status={row.status} />
          <span className="font-bold" aria-hidden>{"\u00b7"}</span>
          <span title={fullDateTitle(row.createdAt)}>
            {formatDate(row.createdAt)}
          </span>
        </p>
      </div>

      <div className="shrink-0 text-right">
        {received && (
          <p className={`truncate font-sans text-[12px] font-bold ${amountToneClass(row.amountTone)}`}>
            {received}
          </p>
        )}
        {paid && <p className="truncate text-[12px] text-[#6B7280]">{paid}</p>}
      </div>
    </div>
  );
}

function CompactStatusText({
  status,
}: {
  status: "success" | "pending" | "failed" | "cancelled";
}) {
  const baseClass = "font-sans text-[11px] font-medium";

  if (status === "success") {
    return <span className={`${baseClass} text-[#61BB84]`}>Completed</span>;
  }
  if (status === "pending") {
    return <span className={`${baseClass} text-[#FFAA90]`}>Pending</span>;
  }
  if (status === "cancelled") {
    return <span className={`${baseClass} text-slate-600`}>Cancelled</span>;
  }
  return <span className={`${baseClass} text-rose-700`}>Failed</span>;
}

function AmountCell({
  label,
  className,
}: {
  label: string | null;
  className: string;
}) {
  // Left-aligned content under a centered header — matches the rest of
  // the row's left-anchored data cells.
  if (!label) return <div className={className}>—</div>;
  const full = formatActivityAmount(label, { compact: false });
  const compact = formatActivityAmount(label, { compact: true });
  return (
    <div className={className}>
      <span className="md:hidden">{full}</span>
      <span
        className="hidden md:inline"
        title={full !== compact ? full : undefined}
      >
        {compact}
      </span>
    </div>
  );
}

/**
 * Full ISO-ish timestamp for the Date cell's hover tooltip. Uses a
 * locale-formatted readable form rather than raw ISO so the tooltip
 * is itself human-readable: "02 May 2026, 13:49:23".
 */
function fullDateTitle(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${date}, ${time}`;
}

// Inline external-link glyph that uses `currentColor` so the parent
// link's text-color classes drive its color (muted grey by default,
// brand-blue on hover). Replaces the old wide "More Details" button.
function ExternalLinkIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M5.5 3.5H3.5C2.94772 3.5 2.5 3.94772 2.5 4.5V10.5C2.5 11.0523 2.94772 11.5 3.5 11.5H9.5C10.0523 11.5 10.5 11.0523 10.5 10.5V8.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 2.5H11.5V6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.5 2.5L6.5 7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityRowsSkeleton() {
  return (
    <div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-1 activity-grid items-center px-5 py-3.5 border-b border-[var(--ex-border)] last:border-b-0"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-100 animate-pulse" />
            <div className="h-3 w-32 bg-slate-100 rounded animate-pulse" />
          </div>
          <div className="h-3 w-24 bg-slate-100 rounded animate-pulse" />
          <div className="h-3 w-32 bg-slate-100 rounded animate-pulse" />
          <div className="h-5 w-16 bg-slate-100 rounded-full animate-pulse" />
          <div className="ml-auto h-7 w-20 bg-slate-100 rounded-lg animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function KindBadge({ kind }: { kind: DashboardActivityKind }) {
  const styles: Record<
    DashboardActivityKind,
    { bg: string; iconSrc: string }
  > = {
    buy: { bg: "bg-[#E7EDFF]", iconSrc: "/icons/activitybuy.svg" },
    sell: { bg: "bg-[#DCFAF8]", iconSrc: "/icons/activitysell.svg" },
    swap: { bg: "bg-[#FFF5D9]", iconSrc: "/icons/activityswap.svg" },
    cashout: { bg: "bg-[#DCFAF8]", iconSrc: "/icons/activitysell.svg" },
    // Refund = funds coming back. Reuses the inflow (buy) glyph on a
    // distinct emerald background to read as "money returned".
    refund: {  bg: "bg-[#F3E8FF]", iconSrc: "/icons/activityrefund.svg" },
    // Staking icons — down-arrow (deposit), up-arrow (withdraw),
    // sparkle (rewards). All share the same rose-tinted background.
    stake: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitydeposited.svg" },
    unstake: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitycollected.svg" },
    reward: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activityclaimed.svg" },
  };
  const s = styles[kind];
  return (
    <span
      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center ${s.bg}`}
    >
      <img
        src={s.iconSrc}
        alt=""
        className={
          kind === "refund"
            ? "h-[16px] w-[16px] sm:h-[18px] sm:w-[18px]"
            : "h-[11px] w-[11px] sm:h-3 sm:w-3"
        }
      />
    </span>
  );
}

function StatusPill({
  status,
}: {
  status: "success" | "pending" | "failed" | "cancelled";
}) {
  const baseClass =
    "inline-flex w-[108px] items-center justify-center px-[18px] py-[7px] text-sm font-medium rounded-md";
  if (status === "success") {
    return (
      <span className={`${baseClass} bg-[#EBFFF3] text-[#61BB84]`}>
        Success
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className={`${baseClass} bg-[#FFF1ED] text-[#FFAA90]`}>
        Pending
      </span>
    );
  }
  if (status === "cancelled") {
    // Neutral grey — reads as "the order didn't happen, no error,
    // nothing to investigate". Distinct from the alarming red used
    // for genuine failures below.
    return (
      <span className={`${baseClass} bg-slate-100 text-slate-600`}>
        Cancelled
      </span>
    );
  }
  // "failed" — red/rose so genuine errors stand out from cancellations.
  return (
    <span className={`${baseClass} bg-rose-100 text-rose-700`}>Failed</span>
  );
}

function amountToneClass(tone: "positive" | "negative" | "neutral"): string {
  if (tone === "positive") return "text-emerald-600";
  if (tone === "negative") return "text-rose-600";
  // Neutral tone — used when the row is a transfer rather than a gain
  // (e.g. a stake deposit, an emergency withdrawal). #374151 matches
  // the slate used by the column headers, so the cell reads as plain
  // data instead of a "+green" profit signal.
  return "text-[#374151]";
}

// Fiat currency codes that the Cash Out flow can settle into. When the
// amount column is denominated in one of these (e.g. "+ 25.12 EUR" from
// a Sell row), we prepend the matching symbol so the value reads
// "+ €25.12 EUR" — consistent with how prices are quoted elsewhere in
// the app. PLAT-prefixed tokens (EURX, USDX, …) are NOT remapped because
// the server always wraps them in parens (e.g. "+ 4.31 (EURX)"), so the
// regex below — which requires a whitespace gap before the code — never
// matches them.
const FIAT_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  BRL: "R$",
};

/**
 * Compact threshold (in absolute value) above which we switch from the
 * full "1,234.56" representation to "1.2k" / "1.5M" / "2B". Anything
 * below stays at 2-decimal precision so everyday transactions read
 * exactly. 10k matches the point where the comma-separated form starts
 * to feel like visual noise relative to the precision it adds.
 */
const COMPACT_THRESHOLD = 10_000;

/**
 * Reformat the numbers inside an amount label.
 *
 * Two modes controlled by `opts.compact`:
 *   • compact=false → always 2 decimals ("1,234.56"). Used on mobile
 *     and for tooltip text where exact value matters.
 *   • compact=true  → numbers ≥ 10k switch to "1.2k" / "1.5M" / "2B"
 *     with one decimal. Numbers below stay full-precision. Used on
 *     desktop where horizontal space is more constrained by the
 *     5-column table layout.
 *
 * In both modes, bare fiat codes (USD/EUR/GBP/BRL) get the matching
 * symbol prepended — "+ 25.12 EUR" becomes "+ €25.12 EUR".
 *
 * Exported so the Exchange page's card-based right-rail can apply the
 * same formatting as the shared table.
 */
export function formatActivityAmount(
  label: string,
  opts: { compact?: boolean } = {}
): string {
  const compact = opts.compact ?? false;

  // 1) Reformat every numeric token. The regex matches a raw "1234" or
  // "1234.56" (no commas at this stage — the server emits unformatted
  // numbers via `formatAmt`).
  const formatted = label.replace(/\d+(?:\.\d+)?/g, (match) => {
    const n = Number(match);
    if (!Number.isFinite(n)) return match;
    if (compact && Math.abs(n) >= COMPACT_THRESHOLD) {
      return formatCompact(n);
    }
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  });

  // 2) Prepend the fiat symbol when the unit is a bare fiat code (no
  // surrounding parens, so platform-tokens are skipped automatically). The
  // number pattern now also matches the compact suffix `k`/`M`/`B`.
  return formatted.replace(
    /([\d,]+(?:\.\d+)?[kMB]?|\d+[kMB]?)\s+(USD|EUR|GBP|BRL)\b/g,
    (_match, num: string, code: string) =>
      `${FIAT_SYMBOLS[code] ?? ""}${num} ${code}`,
  );
}

/**
 * Compact representation with one decimal, swapping the Intl-default
 * uppercase "K" for lowercase "k" (matches the lowercase-k convention
 * common in crypto/fintech UI). "M" and "B" stay uppercase because
 * neither has the same lowercase tradition.
 */
function formatCompact(n: number): string {
  const formatted = n.toLocaleString("en-US", {
    notation: "compact",
    compactDisplay: "short",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return formatted.replace(/K$/, "k");
}

/**
 * Compact, contextual date formatter for the activity table.
 *
 * Tier system, ordered from most-recent to oldest:
 *   • Same calendar day  → "Today, 13:49"
 *   • Day before today   → "Yesterday, 13:49"
 *   • Same calendar year → "02 May, 13:49"
 *   • Different year     → "02 May 2024, 13:49"
 *
 * The relative phrases trade a tiny bit of code for a noticeably more
 * human read on recent items, which dominate the table on most loads.
 * The Date cell wraps this in a `title` attribute with the full ISO
 * timestamp for power users who need exact precision.
 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";

  const now = new Date();
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isSameDay(d, now)) return `Today, ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return `Yesterday, ${time}`;

  const sameYear = d.getFullYear() === now.getFullYear();
  const dateStr = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${dateStr}, ${time}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
