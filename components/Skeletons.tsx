// components/Skeletons.tsx
//
// Layout-matched skeleton loaders for the Dashboard / Exchange / Rewards
// pages. Each skeleton mirrors the structure of its real page so nothing
// shifts when content arrives. Static elements (page header, mode tabs)
// stay visible because they don't depend on data.
//
// Animation is Tailwind's built-in `animate-pulse` — a 2s opacity fade.
// All blocks share the same keyframe so the whole page breathes in sync.

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-[#E5E7EB] ${className}`} />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────

export function DashboardSkeleton() {
  return (
    <div>
      <header>
        <h1 className="font-display text-3xl lg:text-4xl font-semibold text-[#4B5563]">
          Crypto
        </h1>
        <p className="font-display mt-1 text-sm text-[#4B5563]">
          See your balances, recent activity, and token values in one place.
        </p>
      </header>

      {/* Hero row: total balance + PLAT chart */}
      <section className="mt-8 grid items-stretch gap-5 lg:grid-cols-[minmax(420px,0.9fr)_minmax(520px,1.1fr)]">
        <SkeletonBlock className="h-[252px] rounded-[10px]" />
        <SkeletonBlock className="h-[252px] rounded-[10px]" />
      </section>

      {/* Your tokens */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[24px] text-[#4B5563] font-semibold">
            Your tokens
          </h2>
        </div>
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 min-[1024px]:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-[88px]" />
          ))}
        </div>
      </section>

      {/* Recent activity */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[24px] text-[#4B5563] font-semibold">
            Recent activity
          </h2>
        </div>
        <ActivityTableSkeleton rows={8} withHeader />
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Exchange
// ─────────────────────────────────────────────────────────────────────

export function ExchangeSkeleton() {
  return (
    <div className="w-full max-w-full overflow-x-hidden space-y-5 sm:space-y-6 lg:space-y-8">
      <header className="text-center sm:text-left">
        <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#4B5563]">
          Buy or convert your tokens
        </h1>
        <p className="font-display mt-1 text-sm text-[#4B5563] ">
          Buy with card, convert between stablecoins, or sell
        </p>
      </header>

      {/* Tabs strip — three buttons */}
      <div className="grid w-full max-w-full min-w-0 grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="grid w-full min-w-0 grid-cols-3 gap-1 overflow-hidden rounded-[8px] bg-white p-1 shadow-sm">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-[40px] rounded-[4px]" />
            ))}
          </div>
        </div>
      </div>

      {/* Main row: form column + right rail (hero + activity) */}
      <div className="grid w-full max-w-full min-w-0 grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-5">
        {/* Right rail: hero + activity */}
        <div className="contents lg:flex lg:flex-col lg:gap-5 lg:col-start-4 lg:col-span-2 lg:row-start-1 lg:self-start">
          <div className="order-1 lg:order-none">
            {/* BalanceHeroCard */}
            <SkeletonBlock className="h-[250px] rounded-[10px]" />
          </div>
          <div className="order-3 lg:order-none">
            <div className="flex items-center justify-between mb-3">
              <SkeletonBlock className="h-7 w-40" />
              <SkeletonBlock className="h-7 w-20 rounded-[4px]" />
            </div>
            <ActivityTableSkeleton rows={4} />
          </div>
        </div>

        {/* Form column */}
        <div className="order-2 min-w-0 max-w-full lg:order-none lg:col-start-1 lg:col-span-3 lg:row-start-1">
          <FormCardSkeleton />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rewards (Staking)
// ─────────────────────────────────────────────────────────────────────

export function RewardsSkeleton() {
  return (
    <div className="space-y-6 lg:space-y-8">
      <header>
        <h1 className="font-display text-3xl lg:text-4xl font-semibold text-[#4B5563]">
          Earn rewards with your PLAT
        </h1>
        <p className="font-display mt-1 text-sm text-[#4B5563]">
          Deposit your PLAT here to earn rewards every day. You can
          withdraw your tokens later from this page.
        </p>
      </header>

      {/* Tabs strip — two buttons */}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="grid w-full grid-cols-2 gap-1.5 sm:gap-2 overflow-hidden rounded-[8px] bg-white p-1 shadow-sm">
            {Array.from({ length: 2 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-[40px] rounded-[4px]" />
            ))}
          </div>
        </div>
      </div>

      {/* Main row: form column + right rail */}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-5">
          <FormCardSkeleton />
        </div>
        <aside className="lg:col-span-2 space-y-5">
          {/* RewardCard (gradient + claim button) */}
          <SkeletonBlock className="h-[170px] rounded-[10px]" />
          {/* StatCard #1 — Amount currently deposited */}
          <SkeletonBlock className="h-[132px] rounded-xl" />
          {/* StatCard #2 — Estimated Yearly Rewards */}
          <SkeletonBlock className="h-[132px] rounded-xl" />
        </aside>
      </div>

      {/* Recent activity table at the bottom */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-[24px] text-[#4B5563] font-semibold">
            Recent activity
          </h2>
        </div>
        <ActivityTableSkeleton rows={4} withHeader />
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Shared sub-skeletons
// ─────────────────────────────────────────────────────────────────────

/**
 * Activity table skeleton — mirrors `ActivityHistory.ActivityRow`. Used
 * by Dashboard and Rewards (with header) and by Exchange (compact, no
 * header, lives in the right-rail card).
 *
 * Exported so the Exchange's `RecentActivityCard` can render this same
 * skeleton inline while keeping its own title + "See all" header static.
 */
export function ActivityTableSkeleton({
  rows,
  withHeader = false,
}: {
  rows: number;
  withHeader?: boolean;
}) {
  return (
    <div className="ex-card overflow-hidden">
      {withHeader && (
        <div className="hidden md:grid activity-grid px-5 py-[20px] text-[16px] font-semibold text-[#374151] bg-[var(--ex-surface-muted)] border-b border-[var(--ex-border)]">
          <div>Action</div>
          <div>Paid</div>
          <div>Received</div>
          <div>Date</div>
          <div>Status</div>
        </div>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={
            withHeader
              ? "grid grid-cols-1 activity-grid items-center px-5 py-3 border-b border-[var(--ex-border)] last:border-b-0"
              : "flex min-w-0 items-center gap-3 sm:gap-4 px-3 sm:px-5 min-h-[88px] sm:min-h-[96px] border-b border-[#E5E7EB] last:border-b-0"
          }
        >
          {withHeader ? (
            <>
              {/* Skeleton bars left-aligned to mirror the real left-
                  aligned cell content. Headers above stay centered. */}
              <div className="flex items-center gap-3">
                <SkeletonBlock className="h-10 w-10 rounded-full" />
                <SkeletonBlock className="h-4 w-32" />
              </div>
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-7 w-[108px] rounded-md" />
            </>
          ) : (
            <>
              <SkeletonBlock className="h-10 w-10 rounded-full shrink-0" />
              <div className="min-w-0 flex-1 py-3 space-y-2">
                <SkeletonBlock className="h-4 w-32" />
                <SkeletonBlock className="h-3 w-32" />
              </div>
              <div className="shrink-0 space-y-2 text-right">
                <SkeletonBlock className="h-3 w-24 ml-auto" />
                <SkeletonBlock className="h-3 w-20 ml-auto" />
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Form card skeleton — used for BuyForm / SellForm / ConvertForm and
 * StakeCard / UnstakeCard. Roughly the same shape: title, subtitle,
 * two input fields with the connector arrow between them, summary
 * rows, CTA button, fine-print line.
 *
 * Exported so the Staking page can drop this directly into its form
 * column during the initial-load window, instead of rendering the
 * real Stake/Unstake card with misleading "balance: 0" placeholders.
 */
export function FormCardSkeleton() {
  return (
    <div className="ex-card w-full max-w-full min-w-0 overflow-hidden px-4 py-5 sm:px-8 sm:py-9 lg:px-10 lg:py-10">
      <SkeletonBlock className="h-7 w-56" />
      <SkeletonBlock className="mt-3 h-4 w-72" />

      {/* Two input fields with a connector dot between */}
      <div className="mt-8 space-y-3">
        <SkeletonBlock className="h-[104px] rounded-xl" />
        <div className="flex justify-center">
          <SkeletonBlock className="h-9 w-9 rounded-full" />
        </div>
        <SkeletonBlock className="h-[104px] rounded-xl" />
      </div>

      {/* Summary rows (rate / fee / total) */}
      <div className="mt-9">
        <SkeletonBlock className="h-[60px] rounded-xl" />
      </div>

      {/* CTA button */}
      <SkeletonBlock className="mt-10 h-[52px] rounded-[6px]" />

      {/* Fineprint */}
      <SkeletonBlock className="mt-4 h-3 w-3/4 mx-auto" />
    </div>
  );
}
