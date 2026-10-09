// components/Staking.tsx
"use client";

// New "Def" Staking UI from the Figma redesign.
//
// Shape:
//   • Top header: "Earn rewards with your PLAT"
//   • Tab toggle: Start Earning  |  Withdraw tokens
//   • Left form:   amount field + (apy/daily rate OR remaining-deposit) +
//                  primary action button.
//   • Right rail:  blue gradient "Reward ready to collect" card + Claim,
//                  plus "Amount currently deposited" and "Total rewards
//                  earned over time" stat cards.
//   • Bottom:      "Recent activity" table (Action | Amount | Date |
//                  Status | Details).
//
// Web3 / contract logic is NOT re-implemented here. All on-chain reads
// and writes go through the existing server actions in
// app/actions/staking.ts. The 30 s pool-info poll and the
// refresh-after-write chain-state-lag tolerance from the legacy
// StakingDashboard are preserved verbatim.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  stakeAction,
  unstakeAction,
  claimRewardsAction,
  emergencyWithdrawAction,
  getStakingInfoAction,
  getStakingPoolAction,
  getStakingHistoryAction,
} from "@/app/actions/staking";
import {
  getFullActivityAction,
  getActivityCountAction,
  type DashboardActivity,
} from "@/app/actions/dashboard";
import {
  ActivityTable,
  CompactActivityEmptyState,
  CompactActivityList,
  TransactionHistoryModal,
} from "@/components/ActivityHistory";
import { ToastViewport, type Toast } from "@/components/Toast";
import { randomId } from "@/app/lib/client-id";
import { ActivityTableSkeleton } from "@/components/Skeletons";
import { MobilePrimaryNav } from "@/components/AppShell";


// ─────────────────────────────────────────────────────────────────────
// Types & shared metadata
// ─────────────────────────────────────────────────────────────────────

interface UserStakingInfo {
  staked: string;
  pending: string;
  lockUntil: number;
  claimedLifetime: string;
}

interface StakingPoolInfo {
  maxCapacity: string;
  totalStaked: string;
  availableCapacity: string;
  utilizationBps: number;
  rewardBucket: string;
  cumulativeDistributed: string;
  remainingBudget: string;
  currentApyBps: number;
  epochStart: number;
  epochEmissions: string;
  monthlyEmissionCap: string;
  nextEpochTimestamp: number;
  depositsEnabled: boolean;
  minStakeAmount: string;
  minLockDuration: number;
}

interface StakingOrder {
  order_id: string;
  order_type: string;
  status: string;
  amount: string;
  reward_amount: string | null;
  operator_tx_hash: string | null;
  failure_reason: string | null;
  created_at: string;
}

/**
 * In-flight on-chain reward operation. Each handler (stake / unstake /
 * standalone claim) sets this around its server-action await so the user
 * sees a persistent "in progress" toast with a spinner — these calls
 * routinely take 10–15 s on-chain and the button's "Processing…" label
 * alone doesn't convey enough activity.
 *
 * Note: the reward portion of an unstake-with-rewards is covered by the
 * "unstake" banner (which already mentions unclaimed rewards being
 * collected as part of the withdrawal) — we don't fire a separate
 * "claim" banner for that case. Standalone claims from the hero card
 * do get their own banner.
 *
 * Emergency withdrawal intentionally doesn't use this state — its own
 * confirmation modal already sets the "this is a different operation"
 * tone, and the action is meant to feel weightier, not friendlier.
 */
type ActiveRewardOp =
  | { kind: "stake"; amount: string }
  | { kind: "unstake"; amount: string }
  | { kind: "claim" };

/**
 * UI-only claim floor — matches the legacy `MIN_CLAIM_REWARDS_PLAT`
 * in StakingDashboard. The on-chain contract allows claiming any
 * non-zero balance; this is a UX guard so users don't pay gas to
 * collect dust. The Figma "Def" disabled-state tooltip references the
 * same 1 PLAT number as a copy example, hence the default.
 */
const MIN_CLAIM_REWARDS_PLAT = 1;

/**
 * Rewards below this threshold (in PLAT) are treated as zero in the
 * UI — they round to "0.00" at our 2-decimal display precision, so
 * showing them as "+ 0.00 PLAT reward" in banners or as their own
 * "Collect Rewards" history row looks broken. Anything below this is
 * silently rolled into the principal. The on-chain transaction still
 * carries the exact value; this is purely a display rule.
 */
const DUST_REWARD_THRESHOLD = 0.01;

/**
 * Sanity cap for the Stake input. PLAT has a fixed 210 M total
 * supply; refusing keystrokes that would push the typed amount above
 * that bound is purely a UX guard — it keeps the "Estimated daily
 * reward" field from rendering absurd numbers when someone fat-fingers
 * a few extra zeros. The real on-chain checks (balance, pool capacity)
 * are still authoritative on submit.
 */
const PLAT_TOTAL_SUPPLY = 210_000_000;

// ─────────────────────────────────────────────────────────────────────
// Animated amount (count up / count down)
// ─────────────────────────────────────────────────────────────────────

/**
 * Display value for an amount that normally mirrors `real`, but can be
 * explicitly tweened between two values. Used so a deposit/withdrawal can
 * show the amount "draining" from one box while "filling" the other —
 * decoupled from the chain-polling that lands the real numbers seconds
 * later.
 *
 *   • `display`            — the number to render.
 *   • `animate(from, to)`  — run a one-shot count up/down; holds off
 *                            real-tracking so the mid-flight refresh polls
 *                            don't fight the tween.
 *   • `settle()`           — release the hold and snap to the latest real
 *                            value; call once the post-write refresh has
 *                            landed (in a `finally`, so it always runs).
 *
 * Respects prefers-reduced-motion (skips the tween; the value just updates
 * to the real result when it arrives).
 */
function useAnimatedAmount(real: number) {
  const [display, setDisplay] = useState(real);
  // Direction of the in-flight tween, for the count-up/down color flash:
  // "up" (green), "down" (amber), or null (resting). Cleared when the tween
  // ends so a `transition-colors` fades the number back to its normal hue.
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const realRef = useRef(real);
  const rafRef = useRef<number | null>(null);
  const holdRef = useRef(false);

  // Track the real value; snap to it whenever we're not mid-animation.
  useEffect(() => {
    realRef.current = real;
    if (!holdRef.current) setDisplay(real);
  }, [real]);

  // Cancel any in-flight frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  const animate = useCallback((from: number, to: number, duration = 700) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // No tween: let the idle real-tracking show the result when it lands.
    if (reduceMotion || duration <= 0) return;

    holdRef.current = true;
    setFlash(to > from ? "up" : to < from ? "down" : null);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        setDisplay(to);
        // Tween done — drop the flash so the number fades back to normal.
        setFlash(null);
      }
    };
    setDisplay(from);
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const settle = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    holdRef.current = false;
    setFlash(null);
    setDisplay(realRef.current);
  }, []);

  return { display, animate, settle, flash };
}

/**
 * True on lg+ viewports (matches the Tailwind `lg` breakpoint, 1024px).
 * Used to split deposit/withdraw feedback: desktop shows a one-line
 * "in progress" message inline in the card so the eye stays on the count
 * animation; mobile keeps the toast (the inline strip may be scrolled out
 * of view there). SSR-safe: starts false, resolves on mount — fine because
 * the in-flight state only appears after a user action.
 */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

// ─────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────

export default function Staking() {
  // Both actions are visible at once (no tab toggle), so each side owns its
  // own input. `pendingAction` records which write is in flight: `executing`
  // gates BOTH buttons (you can't deposit and withdraw concurrently), while
  // `pendingAction` says which button shows the "Processing…" label.
  const [addAmount, setAddAmount] = useState("");
  const [returnAmount, setReturnAmount] = useState("");
  const [pendingAction, setPendingAction] = useState<"add" | "return" | null>(
    null
  );

  const [userInfo, setUserInfo] = useState<UserStakingInfo | null>(null);
  const [poolInfo, setPoolInfo] = useState<StakingPoolInfo | null>(null);
  const [tglobalBalance, setTglobalBalance] = useState("0");
  const [platSpotPriceUsd, setPlatSpotPriceUsd] = useState<number | null>(null);
  const [orders, setOrders] = useState<StakingOrder[]>([]);
  // Lazy-loaded staking-only activity for the "See all" modal — uses
  // the unified DashboardActivity shape so the modal looks identical to
  // the ones on Dashboard and Exchange.
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [fullActivity, setFullActivity] = useState<DashboardActivity[] | null>(null);
  const [fullActivityLoading, setFullActivityLoading] = useState(false);
  // Staking-only transaction count for the "Showing N of X" hint.
  const [activityTotal, setActivityTotal] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // In-flight on-chain op. Drives the persistent "in progress" banner
  // built below. Cleared in each handler's `finally` block so it's
  // guaranteed to disappear on success, failure, or thrown error.
  const [activeRewardOp, setActiveRewardOp] = useState<ActiveRewardOp | null>(
    null
  );

  const pushToast = (t: Omit<Toast, "id">) => {
    setToasts((prev) => [
      ...prev,
      { ...t, id: randomId() },
    ]);
  };
  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const [showEmergencyConfirm, setShowEmergencyConfirm] = useState(false);

  // Animated display values for the two box balances. They mirror the real
  // numbers normally, but a successful deposit/withdrawal tweens them so the
  // amount visibly drains from one box and fills the other. Display-only —
  // all validation/logic below uses the raw parsed values.
  const balanceAnim = useAnimatedAmount(parseFloat(tglobalBalance));
  const stakedAnim = useAnimatedAmount(parseFloat(userInfo?.staked || "0"));

  // lg+ → show the deposit/withdraw "in progress" line inline in the card
  // (no success toast, so the count animation is the only completion
  // signal); below lg → keep the toasts.
  const isDesktop = useIsDesktop();

  // ─── Data loading ──────────────────────────────────────────────────
  // `loadData` and `refreshAfterWrite` mirror the legacy StakingDashboard
  // behavior. We do NOT re-implement them — the same tolerance for
  // chain-state lag on public Base RPC is essential, otherwise the UI
  // can show "still staked" right after a confirmed unstake.

  const loadData = useCallback(async () => {
    const [dashRes, histRes] = await Promise.allSettled([
      getStakingInfoAction(),
      getStakingHistoryAction(20, 0),
    ]);

    if (dashRes.status === "fulfilled" && dashRes.value.success) {
      setUserInfo(dashRes.value.data.userInfo);
      setPoolInfo(dashRes.value.data.poolInfo);
      setTglobalBalance(dashRes.value.data.tglobalBalance);
      setPlatSpotPriceUsd(dashRes.value.data.platSpotPriceUsd);
    }
    if (histRes.status === "fulfilled" && histRes.value.success) {
      setOrders(histRes.value.data as StakingOrder[]);
    }
    setLoading(false);
  }, []);

  const refreshAfterWrite = useCallback(
    async (
      expect: (next: UserStakingInfo, nextBalance: string) => boolean
    ) => {
      const maxAttempts = 6;
      const delayMs = 800;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await loadData();
        const latestDash = await getStakingInfoAction();
        if (latestDash.success) {
          const { userInfo: u, tglobalBalance: b } = latestDash.data;
          if (expect(u, b)) {
            setUserInfo(u);
            setTglobalBalance(b);
            setPoolInfo(latestDash.data.poolInfo);
            setPlatSpotPriceUsd(latestDash.data.platSpotPriceUsd);
            return;
          }
        }
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    },
    [loadData]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [dashRes, histRes, countRes] = await Promise.allSettled([
        getStakingInfoAction(),
        getStakingHistoryAction(20, 0),
        getActivityCountAction(),
      ]);
      if (cancelled) return;
      if (dashRes.status === "fulfilled" && dashRes.value.success) {
        setUserInfo(dashRes.value.data.userInfo);
        setPoolInfo(dashRes.value.data.poolInfo);
        setTglobalBalance(dashRes.value.data.tglobalBalance);
        setPlatSpotPriceUsd(dashRes.value.data.platSpotPriceUsd);
      }
      if (histRes.status === "fulfilled" && histRes.value.success) {
        setOrders(histRes.value.data as StakingOrder[]);
      }
      if (countRes.status === "fulfilled" && countRes.value.success) {
        setActivityTotal(countRes.value.data.staking);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pool info refresh every 30 s — preserves the legacy cadence so APY
  // / capacity / utilization stay current without manual refresh.
  useEffect(() => {
    const id = setInterval(async () => {
      const res = await getStakingPoolAction();
      if (res.success) setPoolInfo(res.data as StakingPoolInfo);
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Lazy-fetch the full Staking-only activity feed the first time the
  // user opens the "See all" modal. Subsequent opens reuse the cache.
  // `setFullActivityLoading(true)` lives inside the IIFE to satisfy
  // React 19's react-hooks/set-state-in-effect rule. The guard depends
  // on `fullActivity` (not `fullActivityLoading`) so the in-flight
  // fetch isn't self-cancelled when the loading flag flips.
  useEffect(() => {
    if (!activityModalOpen || fullActivity) return;
    let cancelled = false;
    (async () => {
      setFullActivityLoading(true);
      const res = await getFullActivityAction("staking");
      if (cancelled) return;
      setFullActivityLoading(false);
      if (res.success) setFullActivity(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [activityModalOpen, fullActivity]);

  // ─── Write handlers ────────────────────────────────────────────────

  const handleStake = async () => {
    if (!addAmount || parseFloat(addAmount) <= 0) return;
    const stakedBefore = parseFloat(userInfo?.staked || "0");
    const balanceBefore = parseFloat(tglobalBalance);
    const stakeAmt = parseFloat(addAmount);
    setExecuting(true);
    setPendingAction("add");
    setActiveRewardOp({ kind: "stake", amount: addAmount });
    // The in-flight banner only covers the on-chain await — we clear it
    // before the success/error toast fires so the two don't visually
    // collide ("Deposit complete" + "Deposit in progress" together would
    // be confusing). `refreshAfterWrite` keeps `executing` true so the
    // button stays "Processing…" while the chain settles.
    let result: Awaited<ReturnType<typeof stakeAction>>;
    try {
      result = await stakeAction(addAmount);
    } finally {
      setActiveRewardOp(null);
    }
    if (result.success) {
      // On desktop the count animation is the completion signal, so skip
      // the success toast (it competes with the animation for attention).
      // Mobile keeps it — the inline message may be scrolled out of view.
      if (!isDesktop) {
        pushToast({
          variant: "success",
          title: "Deposit complete",
          description: `${formatTokenAmount(stakeAmt)} PLAT is now earning rewards`,
        });
      }
      setAddAmount("");
      // Drain the balance box, fill the Rewards box, simultaneously.
      balanceAnim.animate(balanceBefore, balanceBefore - stakeAmt);
      stakedAnim.animate(stakedBefore, stakedBefore + stakeAmt);
      try {
        await refreshAfterWrite(
          (next) => parseFloat(next.staked) >= stakedBefore + stakeAmt * 0.999
        );
      } finally {
        balanceAnim.settle();
        stakedAnim.settle();
      }
    } else {
      pushToast({
        variant: "error",
        title: "Deposit failed",
        description: result.error,
      });
      await loadData();
    }
    setExecuting(false);
    setPendingAction(null);
  };

  const handleUnstake = async () => {
    if (!returnAmount || parseFloat(returnAmount) <= 0) return;
    const stakedBefore = parseFloat(userInfo?.staked || "0");
    const balanceBefore = parseFloat(tglobalBalance);
    const unstakeAmt = parseFloat(returnAmount);
    setExecuting(true);
    setPendingAction("return");
    setActiveRewardOp({ kind: "unstake", amount: returnAmount });
    // See `handleStake` for the rationale on clearing the banner before
    // the result toast fires. The unstake banner copy mentions rewards
    // coming along, so we deliberately do NOT fire a separate "claim"
    // banner for unstake-with-rewards — they're the same on-chain tx.
    let result: Awaited<ReturnType<typeof unstakeAction>>;
    try {
      result = await unstakeAction(returnAmount);
    } finally {
      setActiveRewardOp(null);
    }
    if (result.success) {
      const rewardAmt =
        result.data.reward_amount ? parseFloat(result.data.reward_amount) : 0;
      const rewardMsg =
        rewardAmt >= DUST_REWARD_THRESHOLD
          ? ` + ${formatTokenAmount(rewardAmt)} PLAT reward`
          : "";
      // Desktop: the count animation is the completion signal (skip toast).
      // Mobile: keep the toast.
      if (!isDesktop) {
        pushToast({
          variant: "success",
          title: "Withdrawal complete",
          description: `${formatTokenAmount(unstakeAmt)} PLAT${rewardMsg} added to your balance`,
        });
      }
      setReturnAmount("");
      // Drain the Rewards box, fill the balance box (principal + any rewards
      // collected in the same tx), simultaneously.
      stakedAnim.animate(stakedBefore, stakedBefore - unstakeAmt);
      balanceAnim.animate(balanceBefore, balanceBefore + unstakeAmt + rewardAmt);
      try {
        await refreshAfterWrite(
          (next) => parseFloat(next.staked) <= stakedBefore - unstakeAmt * 0.999
        );
      } finally {
        stakedAnim.settle();
        balanceAnim.settle();
      }
    } else {
      pushToast({
        variant: "error",
        title: "Withdrawal failed",
        description: result.error,
      });
      await loadData();
    }
    setExecuting(false);
    setPendingAction(null);
  };

  const handleClaim = async () => {
    const pendingBefore = parseFloat(userInfo?.pending || "0");
    if (pendingBefore < MIN_CLAIM_REWARDS_PLAT) {
      pushToast({
        variant: "warning",
        title: "Not enough rewards yet",
        description: `Earn at least ${MIN_CLAIM_REWARDS_PLAT} PLAT to claim your reward.`,
      });
      return;
    }
    setClaiming(true);
    setActiveRewardOp({ kind: "claim" });
    // Banner clears before the result toast fires — same pattern as
    // stake / unstake. Only fires for standalone claims from the hero
    // card; the reward portion of an unstake-with-rewards is covered
    // by the unstake banner instead (one on-chain tx, one banner).
    let result: Awaited<ReturnType<typeof claimRewardsAction>>;
    try {
      result = await claimRewardsAction();
    } finally {
      setActiveRewardOp(null);
    }
    if (result.success) {
      const claimed = parseFloat(result.data.reward_amount || "0");
      pushToast({
        variant: "success",
        title: "Reward claimed",
        description: `${formatTokenAmount(claimed)} PLAT added to your balance`,
      });
      await refreshAfterWrite(
        (next) => parseFloat(next.pending) < pendingBefore * 0.5
      );
    } else {
      pushToast({
        variant: "error",
        title: "Reward claim failed",
        description: result.error,
      });
      await loadData();
    }
    setClaiming(false);
  };

  const handleEmergencyWithdraw = async () => {
    setShowEmergencyConfirm(false);
    const stakedBefore = parseFloat(userInfo?.staked || "0");
    const balanceBefore = parseFloat(tglobalBalance);
    setExecuting(true);
    setPendingAction("return");
    const result = await emergencyWithdrawAction();
    if (result.success) {
      const returned = parseFloat(result.data.amount);
      pushToast({
        variant: "success",
        title: "Emergency withdrawal complete",
        description: `${formatTokenAmount(returned)} PLAT returned to your balance (rewards forfeited)`,
      });
      // Drain the Rewards box, fill the balance box (principal only —
      // rewards are forfeited on an emergency withdrawal).
      stakedAnim.animate(stakedBefore, Math.max(0, stakedBefore - returned));
      balanceAnim.animate(balanceBefore, balanceBefore + returned);
      try {
        await refreshAfterWrite(
          (next) => parseFloat(next.staked) < stakedBefore * 0.5
        );
      } finally {
        stakedAnim.settle();
        balanceAnim.settle();
      }
    } else {
      pushToast({
        variant: "error",
        title: "Emergency withdrawal failed",
        description: result.error,
      });
      await loadData();
    }
    setExecuting(false);
    setPendingAction(null);
  };

  // ─── Derived state ─────────────────────────────────────────────────

  // EMPTY STATE FUNCTION - deposit sections (unstake / deposited / reward) - const stakedAmount = 0;

  const stakedAmount = parseFloat(userInfo?.staked || "0");

  // EMPTY STATE FUNCTION - rewards card - const pendingRewards = 0;

  const pendingRewards = parseFloat(userInfo?.pending || "0");

  // EMPTY STATE FUNCTION - stake card - const balanceNum = 0;

  const balanceNum = parseFloat(tglobalBalance);

  const apyBps = poolInfo?.currentApyBps ?? 0;
  const apyPercent = apyBps / 100;

  // Projected annual earnings on the user's *existing* deposit (drives
  // the right-rail "Estimated Yearly Rewards" card). Distinct from the
  // in-form row's value, which is based on the typed amount. When
  // there's no deposit, this is 0 and the card displays explicit zero
  // values to preserve the regular funded-state layout.
  const currentDepositYearlyReward =
    poolInfo && stakedAmount > 0 ? (stakedAmount * apyPercent) / 100 : 0;
  const currentDepositYearlyRewardUsd =
    platSpotPriceUsd != null && currentDepositYearlyReward >= 0.005
      ? currentDepositYearlyReward * platSpotPriceUsd
      : null;
  const lockStatus = userInfo
    ? formatLockStatus(userInfo.lockUntil)
    : { text: "—", locked: false };

  // Treat sub-cent dust as "no balance" — the Convert / Sell minimums are
  // orders of magnitude above a cent, so a dust remainder of (say) 0.0059
  // PLAT is unspendable. Without this floor the empty-state "Buy
  // Tokens" CTA would stay hidden for users who effectively have nothing.
  const hasBalance = balanceNum >= 0.01;
  const hasDeposit = stakedAmount > 0;

  // The pool reports its per-action floor via `minStakeAmount` (string,
  // PLAT units). It gates both the deposit and withdrawal sides, so
  // users get an in-card warning + greyed-out button rather than a
  // server-side error after submitting.
  const minStakeAmount = parseFloat(poolInfo?.minStakeAmount ?? "0");

  // ── Add (deposit) field — validated independently of the Return side ──
  const addEntered = parseFloat(addAmount || "0");
  const validAdd = Number.isFinite(addEntered) && addEntered > 0;
  const insufficientAdd = validAdd && addEntered > balanceNum;
  const belowMinAdd =
    validAdd && minStakeAmount > 0 && addEntered < minStakeAmount;
  const canAdd =
    validAdd &&
    !insufficientAdd &&
    !belowMinAdd &&
    !executing &&
    !!poolInfo?.depositsEnabled &&
    hasBalance;

  // ── Return (withdraw) field ──
  const returnEntered = parseFloat(returnAmount || "0");
  const validReturn = Number.isFinite(returnEntered) && returnEntered > 0;
  const insufficientReturn = validReturn && returnEntered > stakedAmount;
  const belowMinReturn =
    validReturn && minStakeAmount > 0 && returnEntered < minStakeAmount;
  const canReturn =
    validReturn &&
    !insufficientReturn &&
    !belowMinReturn &&
    !lockStatus.locked &&
    !executing &&
    hasDeposit;

  const canClaim =
    !claiming && pendingRewards >= MIN_CLAIM_REWARDS_PLAT;

  // ─── Render ────────────────────────────────────────────────────────
  //
  // No early-return on `loading`. The page chrome (header, mode tabs,
  // right-rail card chrome) renders on frame one. Only the dynamic
  // values inside the right-rail cards skeleton; the form column uses
  // FormCardSkeleton while loading because StakeCard/UnstakeCard
  // derive too many enabled/disabled states from snapshot data — a
  // zero-balance render would read as "you have nothing" instead of
  // "we're still loading".

  return (
    // Header, h1 and subtitle classes are kept in lock-step with the
    // Dashboard (components/Dashboard.tsx) and Exchange
    // (components/Exchange.tsx) pages so the title and subtitle don't
    // shift when the user navigates between Dashboard / Exchange /
    // Staking. The tabs-row + outer wrapper classes are shared with
    // Exchange only (Dashboard has no mode selector). If you change one,
    // change the others.
    <div className="w-full max-w-full overflow-x-hidden space-y-5 sm:space-y-6 lg:space-y-8">
      <header className="text-center sm:text-left">
        <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#4B5563]">
          Earn rewards with your PLAT
        </h1>
        <p className="font-sans mt-1 text-sm text-[#4B5563]">
          Add PLAT to Rewards to earn daily. The more you add, the more rewards you can earn.
        </p>
      </header>
      <MobilePrimaryNav />

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Form column */}
        <div className="lg:col-span-3 space-y-5">
          <ManageRewardsCard
            // Add (deposit) side
            addAmount={addAmount}
            onAddChange={setAddAmount}
            balance={balanceNum}
            balanceDisplay={balanceAnim.display}
            balanceFlash={balanceAnim.flash}
            hasBalance={hasBalance}
            depositsEnabled={!!poolInfo?.depositsEnabled}
            insufficientAdd={insufficientAdd}
            belowMinAdd={belowMinAdd}
            canAdd={!!canAdd}
            addBusy={pendingAction === "add"}
            onAdd={handleStake}
            // Return (withdraw) side
            returnAmount={returnAmount}
            onReturnChange={setReturnAmount}
            stakedAmount={stakedAmount}
            stakedDisplay={stakedAnim.display}
            stakedFlash={stakedAnim.flash}
            hasDeposit={hasDeposit}
            lockStatus={lockStatus}
            insufficientReturn={insufficientReturn}
            belowMinReturn={belowMinReturn}
            canReturn={!!canReturn}
            returnBusy={pendingAction === "return"}
            onReturn={handleUnstake}
            // Shared
            minStakeAmount={minStakeAmount}
            executing={executing}
            loading={loading}
            // Desktop-only inline progress line (replaces the helper text
            // while a deposit/withdraw is on-chain). Null on mobile, where
            // the toast banner covers it instead.
            inProgress={
              isDesktop && activeRewardOp
                ? activeRewardOp.kind === "stake"
                  ? "deposit"
                  : activeRewardOp.kind === "unstake"
                  ? "withdraw"
                  : null
                : null
            }
          />

          {/* Emergency withdraw lives under the form column on locked stakes
              — same affordance as the legacy UI, just restyled to fit the
              light card aesthetic. */}
          {hasDeposit && lockStatus.locked && (
            <div className="ex-card p-5 border-red-200 bg-red-50/50">
              <h3 className="text-sm font-semibold text-red-700">
                Emergency Withdrawal
              </h3>
              <p className="mt-1 text-xs text-red-700/80">
                Withdraw your deposited PLAT immediately, forfeiting all
                accrued rewards. Use only if absolutely necessary.
              </p>
              <button
                type="button"
                onClick={() => setShowEmergencyConfirm(true)}
                disabled={executing}
                className="mt-3 w-full py-2.5 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Emergency Withdraw
              </button>
            </div>
          )}
        </div>

        {/* Right rail — grid with `auto / 1fr / 1fr` rows so the
            RewardCard keeps its natural height while the two StatCards
            below split any remaining vertical space. On lg+ the cell
            stretches to match the form column's height (StakeCard is
            usually the tallest item), so the bottom of the Estimated
            Yearly Rewards card lines up with the bottom of the
            Stake/Unstake card. `minmax(0, 1fr)` lets the StatCards
            shrink past their content's natural height if ever needed,
            instead of overflowing. */}
        <aside className="lg:col-span-2 grid grid-rows-[auto_auto_minmax(0,1fr)_minmax(0,1fr)] gap-4 lg:h-full">
          <RewardCard
            pendingRewards={pendingRewards}
            claimable={canClaim}
            claiming={claiming}
            onClaim={handleClaim}
            hasDeposit={hasDeposit}
            loading={loading}
          />
          {/* Sub-heading labelling the two Q&A cards below. Sits as its
              own `auto` grid row between the hero and the StatCards — this
              also lifts the rail's minimum height a touch, which lets the
              form card stretch and breathe (see ManageRewardsCard's
              justify-between). */}
          <h2 className="mt-1.5 px-1 font-display text-[18px] font-semibold leading-tight text-[#4B5563]">
            Earnings Information
          </h2>
          <StatCard
            iconSrc="/icons/staking-rewards.svg"
            title="How much can I earn?"
            value={poolInfo ? `${apyPercent.toFixed(0)}%` : "—"}
            token="of your deposit per year"
            caption="A high rewards rate compared with traditional savings. Rewards are added daily."
            loading={loading}
          />
          <StatCard
            iconSrc="/icons/staking-deposited.svg"
            title="How much am I earning per year?"
            value={currentDepositYearlyReward.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            token="PLAT"
            usdAnnotation={
              currentDepositYearlyRewardUsd != null
                ? `($${currentDepositYearlyRewardUsd.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })})`
                : !hasDeposit
                ? "($0.00)"
                : undefined
            }
            caption={
              currentDepositYearlyReward > 0
                ? `Based on your current deposit and ${apyPercent.toFixed(
                    0
                  )}% per year.`
                : "Deposit PLAT to see your projected yearly earnings."
            }
            loading={loading}
          />
        </aside>
      </div>


      <RecentActivityTable
        orders={orders}
        onSeeAll={() => setActivityModalOpen(true)}
        total={activityTotal}
        loading={loading}
      />

      {activityModalOpen && (() => {
        // The inline table uses raw StakingOrder data. The modal uses
        // the unified DashboardActivity shape (same renderer as the
        // Dashboard / Exchange modals) — so until the lazy fetch
        // returns, render an empty list with the loading skeleton.
        const modalRows = fullActivity ?? [];
        const modalLoading = modalRows.length === 0 && fullActivityLoading;
        return (
          <TransactionHistoryModal
            rows={modalRows}
            loading={modalLoading}
            onClose={() => setActivityModalOpen(false)}
          />
        );
      })()}

      {showEmergencyConfirm && (
        <EmergencyConfirmModal
          stakedAmount={stakedAmount}
          pendingRewards={pendingRewards}
          onCancel={() => setShowEmergencyConfirm(false)}
          onConfirm={handleEmergencyWithdraw}
        />
      )}

      <ToastViewport
        toasts={(() => {
          // Persistent in-flight banner derived from `activeRewardOp`,
          // appended to the transient toast array so the existing X
          // dismiss + auto-close logic for the others stays untouched.
          // The toast renders with a spinner because `collapsible: true`
          // triggers the SpinnerIcon variant in Toast.tsx.
          if (!activeRewardOp) return toasts;
          // On desktop, deposit/withdraw progress is shown inline in the
          // card (so the eye stays on the count animation), so suppress
          // their banner here. Claim has no inline equivalent, so it keeps
          // the banner on every screen.
          if (
            isDesktop &&
            (activeRewardOp.kind === "stake" ||
              activeRewardOp.kind === "unstake")
          ) {
            return toasts;
          }
          const banner: Toast =
            activeRewardOp.kind === "stake"
              ? {
                  id: "rewards-inflight-stake",
                  variant: "info",
                  collapsible: true,
                  title: "Deposit in progress",
                  description: `Depositing ${formatTokenAmount(
                    parseFloat(activeRewardOp.amount)
                  )} PLAT to start earning rewards. This usually takes 10–15 seconds.`,
                }
              : activeRewardOp.kind === "unstake"
              ? {
                  id: "rewards-inflight-unstake",
                  variant: "info",
                  collapsible: true,
                  title: "Withdrawal in progress",
                  description: `Withdrawing ${formatTokenAmount(
                    parseFloat(activeRewardOp.amount)
                  )} PLAT. Any unclaimed earned rewards will now be collected as well. This usually takes 10–15 seconds.`,
                }
              : {
                  id: "rewards-inflight-claim",
                  variant: "info",
                  collapsible: true,
                  title: "Claiming rewards",
                  description:
                    "Collecting your earned rewards. This usually takes 10–15 seconds.",
                };
          return [...toasts, banner];
        })()}
        onDismiss={dismissToast}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Manage Rewards balance card (status chip + dual-action panel)
// ─────────────────────────────────────────────────────────────────────

// Status chip — info (blue) / warning (amber) / ready (green). Always
// rendered when shown so swapping between states doesn't shift the
// card's height. Mirrors the helper used by the Exchange forms.
type ChipState = {
  variant: "info" | "warning" | "ready";
  message: React.ReactNode;
};

type RewardHelper = {
  variant?: "info" | "success" | "warning";
  message: React.ReactNode;
  cta?: { href: string; label: string };
};

function RewardsMessageStrip({ helper }: { helper: RewardHelper }) {
  // Palette + chrome kept in lock-step with Exchange's StatusChip
  // (components/Exchange.tsx) so the helper messages read identically
  // across the two pages — same font/size/weight (text-sm), same
  // border/background/text colors, same min-height and padding, and no
  // leading dot. The only addition here is the optional CTA link, which
  // tracks the active variant's text color.
  const variant = helper.variant ?? "info";
  const palette =
    variant === "warning"
      ? {
          wrapper: "border-amber-200 bg-amber-50 text-amber-800",
          link: "text-amber-800 hover:text-amber-700",
        }
      : variant === "success"
      ? {
          wrapper: "border-emerald-200 bg-emerald-50 text-emerald-800",
          link: "text-emerald-800 hover:text-emerald-700",
        }
      : {
          wrapper: "border-sky-200 bg-sky-50 text-sky-800",
          link: "text-sky-800 hover:text-sky-700",
        };

  return (
    <div
      className={`flex min-h-[40px] items-center rounded-md border px-3 py-2 text-sm ${palette.wrapper}`}
    >
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <p>{helper.message}</p>
        {helper.cta && (
          <Link
            href={helper.cta.href}
            className={`inline-flex shrink-0 text-sm font-semibold underline underline-offset-2 ${palette.link}`}
          >
            {helper.cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}

function ManageRewardsCard({
  // Add (deposit) side
  addAmount,
  onAddChange,
  balance,
  balanceDisplay,
  balanceFlash,
  hasBalance,
  depositsEnabled,
  insufficientAdd,
  belowMinAdd,
  canAdd,
  addBusy,
  onAdd,
  // Return (withdraw) side
  returnAmount,
  onReturnChange,
  stakedAmount,
  stakedDisplay,
  stakedFlash,
  hasDeposit,
  lockStatus,
  insufficientReturn,
  belowMinReturn,
  canReturn,
  returnBusy,
  onReturn,
  // Shared
  minStakeAmount,
  executing,
  loading = false,
  inProgress = null,
}: {
  addAmount: string;
  onAddChange: (v: string) => void;
  balance: number;
  /** Animated value for the big number only; logic still uses `balance`. */
  balanceDisplay: number;
  /** Count direction for the color flash on the balance number. */
  balanceFlash: "up" | "down" | null;
  hasBalance: boolean;
  depositsEnabled: boolean;
  insufficientAdd: boolean;
  belowMinAdd: boolean;
  canAdd: boolean;
  addBusy: boolean;
  onAdd: () => void;
  returnAmount: string;
  onReturnChange: (v: string) => void;
  stakedAmount: number;
  /** Animated value for the big number only; logic still uses `stakedAmount`. */
  stakedDisplay: number;
  /** Count direction for the color flash on the staked number. */
  stakedFlash: "up" | "down" | null;
  hasDeposit: boolean;
  lockStatus: { text: string; locked: boolean };
  insufficientReturn: boolean;
  belowMinReturn: boolean;
  canReturn: boolean;
  returnBusy: boolean;
  onReturn: () => void;
  minStakeAmount: number;
  executing: boolean;
  /** Same skeleton contract as the old StakeCard — chrome paints, data pulses. */
  loading?: boolean;
  /**
   * When set, an on-chain deposit/withdraw is in flight: the helper strip
   * shows a one-line "in progress" message instead of the usual guidance.
   * Desktop-only — the parent passes null on mobile (toast covers it there).
   */
  inProgress?: "deposit" | "withdraw" | null;
}) {
  // Per-side validation. Warnings are surfaced in the shared strip below both
  // CTAs so the inputs and buttons stay visually paired.
  const addValidation: ChipState | null = (() => {
    if (loading || !hasBalance) return null;
    if (!depositsEnabled) {
      return {
        variant: "warning",
        message:
          "Adding PLAT to Rewards is temporarily paused. Please try again later.",
      };
    }
    if (insufficientAdd) {
      return {
        variant: "warning",
        message: `You have ${formatTokenAmount(balance)} PLAT available to add.`,
      };
    }
    if (belowMinAdd) {
      return {
        variant: "warning",
        message: `Minimum amount to add is ${formatTokenAmount(minStakeAmount)} PLAT.`,
      };
    }
    return null;
  })();

  const returnValidation: ChipState | null = (() => {
    if (loading || !hasDeposit) return null;
    if (lockStatus.locked) {
      return {
        variant: "warning",
        message:
          "Your PLAT is still locked. Use Emergency Withdraw only if you need access now — rewards will be forfeited.",
      };
    }
    if (insufficientReturn) {
      return {
        variant: "warning",
        message: `You have ${formatTokenAmount(stakedAmount)} PLAT available to return.`,
      };
    }
    if (belowMinReturn) {
      return {
        variant: "warning",
        message: `Minimum amount to return is ${formatTokenAmount(minStakeAmount)} PLAT.`,
      };
    }
    return null;
  })();

  const sharedValidation = addValidation ?? returnValidation;
  const sharedMessage: RewardHelper = loading
    ? {
        message:
          "Add Tokens to the Rewards Pool to start earning daily. You can move them back anytime.",
      }
    : sharedValidation
    ? { variant: "warning", message: sharedValidation.message }
    : canAdd
    ? {
        variant: "success",
        message:
          "Ready to add. This PLAT will start earning daily rewards right away.",
      }
    : canReturn
    ? {
        variant: "success",
        message:
          "Ready to return. This PLAT will move back to your balance, and any earned rewards will be collected.",
      }
    : !hasBalance && hasDeposit
    ? {
        variant: "success",
        message:
          "All your PLAT is currently earning rewards. Move some back if you want it available in your balance.",
      }
    : hasDeposit
    ? {
        variant: "success",
        message:
          "Your PLAT is earning daily rewards. You can move your deposit back to your balance anytime.",
      }
    : hasBalance
    ? {
        message:
          "Add Tokens to the Rewards Pool to start earning daily. You can move them back anytime.",
      }
    : {
        // The inline "Buy PLAT" is the link itself, so there's no
        // separate trailing CTA repeating the same words.
        message: (
          <>
            You&apos;ll need PLAT before you can start earning.{" "}
            <Link
              href="/exchange?mode=buy"
              className="font-semibold text-sky-800 underline underline-offset-2 hover:text-sky-700"
            >
              Buy PLAT
            </Link>
            , then add it to Rewards.
          </>
        ),
      };

  return (
    // No justify-between here: outer gaps (header→columns→helper) stay
    // fixed via the mt-* values so we don't get empty bands above/below
    // the boxes. Any extra height the card receives (when the right rail
    // is taller and stretches this column) is absorbed by the columns
    // grid below — see its `flex-1` + `sm:grid-rows-1` — which passes the
    // stretch down into each box so its contents can breathe.
    <div className="ex-card flex h-full flex-col px-5 pt-8 pb-5 sm:px-8 sm:pt-10 sm:pb-6 lg:px-10 lg:pt-11 lg:pb-7">
      <div>
        <h2 className="font-display text-[20px] sm:text-[24px] lg:text-[28px] font-semibold leading-[1.15] text-[#111827]">
          Manage your Rewards
        </h2>
        <p className="font-sans mt-2 text-[13px] sm:text-[15px] font-normal leading-[20px] text-[#6B7280]">
          Add PLAT to the Rewards Pool to start earning daily rewards.
        </p>
      </div>

      {/* Two always-visible action buckets. The inner cards create the
          separation, so no divider is needed between columns. */}
      <div className="mt-8 grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 sm:grid-rows-1 sm:gap-5">
        <div>
          <RewardColumn
            label="In your Balance"
            balanceText={formatTokenAmount(floorToCents(balanceDisplay))}
            valueFlash={balanceFlash}
            statusVariant={hasBalance ? "active" : "muted"}
            statusText={hasBalance ? "Ready to add" : "No PLAT"}
            inputLabel="Move Tokens to Rewards Pool"
            amount={addAmount}
            onAmountChange={onAddChange}
            onMax={
              hasBalance
                ? () => onAddChange(floorToCents(balance).toFixed(2))
                : undefined
            }
            maxLabel="Deposit All"
            inputDisabled={!hasBalance || executing}
            buttonLabel="Add PLAT to Rewards"
            buttonVariant="primary"
            onSubmit={onAdd}
            canSubmit={canAdd}
            busy={addBusy}
            loading={loading}
          />
        </div>
        <div>
          <RewardColumn
            label="In Rewards Pool"
            balanceText={formatTokenAmount(floorToCents(stakedDisplay))}
            valueFlash={stakedFlash}
            statusVariant={
              !hasDeposit ? "muted" : lockStatus.locked ? "warning" : "active"
            }
            statusText={
              !hasDeposit
                ? "No active deposit"
                : lockStatus.locked
                ? lockStatus.text
                : "Earning daily"
            }
            inputLabel="Move Tokens back to your Balance"
            amount={returnAmount}
            onAmountChange={onReturnChange}
            onMax={
              hasDeposit && !lockStatus.locked
                ? () => onReturnChange(floorToCents(stakedAmount).toFixed(2))
                : undefined
            }
            maxLabel="Withdraw All"
            inputDisabled={!hasDeposit || lockStatus.locked || executing}
            buttonLabel="Return PLAT to Balance"
            buttonVariant="outline"
            onSubmit={onReturn}
            canSubmit={canReturn}
            busy={returnBusy}
            loading={loading}
          />
        </div>
      </div>

      {/* Bigger gap above the helper than the other mt-* in this card.
          Because the boxes grid is flex-1, widening this margin steals
          height from the grid → the boxes get shorter, pulling their
          bottom-pinned CTAs up toward the divider, and the helper strip
          gets more room to breathe below them. */}
      <div className="mt-7">
        {inProgress ? (
          <RewardsMessageStrip
            helper={{
              variant: "info",
              message: (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {inProgress === "deposit"
                    ? "Deposit in progress…"
                    : "Withdrawal in progress…"}
                </span>
              ),
            }}
          />
        ) : (
          <RewardsMessageStrip helper={sharedMessage} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Reward action column (one side of the Manage Rewards card)
// ─────────────────────────────────────────────────────────────────────

function RewardColumn({
  label,
  balanceText,
  valueFlash = null,
  statusVariant,
  statusText,
  inputLabel,
  amount,
  onAmountChange,
  onMax,
  maxLabel = "MAX",
  inputDisabled,
  buttonLabel,
  buttonVariant,
  onSubmit,
  canSubmit,
  busy,
  loading = false,
}: {
  label: string;
  balanceText: string;
  /** Count direction for the big number's color flash: up=green, down=amber. */
  valueFlash?: "up" | "down" | null;
  statusVariant: "active" | "muted" | "warning";
  statusText: string;
  inputLabel: string;
  amount: string;
  onAmountChange: (v: string) => void;
  /** Provide to render an enabled fill-the-field shortcut. */
  onMax?: () => void;
  /** Text for that shortcut, e.g. "Deposit All" / "Withdraw All". */
  maxLabel?: string;
  inputDisabled: boolean;
  buttonLabel: string;
  buttonVariant: "primary" | "outline";
  onSubmit: () => void;
  canSubmit: boolean;
  busy: boolean;
  loading?: boolean;
}) {
  // Status pill — same shape as the "Live" pill on the Exchange rate card
  // (rounded-full, tinted bg, colored dot + matching text). Hue tracks the
  // state: green = active, amber = paused/locked, gray = neutral/empty.
  const statusPill =
    statusVariant === "active"
      ? { wrap: "bg-emerald-100 text-emerald-700", dot: "bg-emerald-500" }
      : statusVariant === "warning"
      ? { wrap: "bg-amber-100 text-amber-700", dot: "bg-amber-500" }
      : { wrap: "bg-slate-100 text-slate-500", dot: "bg-slate-400" };

  const buttonClass = !canSubmit
    ? "w-full h-[50px] rounded-[6px] bg-[#D8DEE7] text-[#738094] text-[15px] font-semibold cursor-not-allowed transition-colors"
    : buttonVariant === "primary"
    ? "w-full h-[50px] rounded-[6px] bg-[#0EA5E9] hover:bg-[#3EB7ED] text-white text-[15px] font-semibold shadow-sm transition-colors"
    : "w-full h-[50px] rounded-[6px] border-2 border-[#0EA5E9] bg-white text-[#0EA5E9] hover:bg-[#F0F9FF] text-[15px] font-semibold transition-colors";

  return (
    <div className="flex flex-col rounded-[16px] border border-[#E6EDF3] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      {/* Four direct children use explicit 24px spacing. Breaking the
          balance out of the title group gives it its
          own line — centred between the title and the amount field. Its
          mt-* below is the tunable knob for nudging it when the box isn't
          stretched. */}
      {/* Header row: title left, small status badge top-right. The status
          (dot + short copy) used to sit under the balance amount — moved
          up here so the balance area stays clean and the eye lands on the
          input field. Badge text is muted gray; the dot carries the
          state color. `min-w-0` on the title lets it truncate before the
          badge wraps on very narrow widths. */}
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 font-sans text-[17px] font-semibold leading-[22px] text-[#374151] sm:text-[16px]">
          {label}
        </p>
        {loading ? (
          <span
            aria-hidden
            className="inline-block h-[26px] w-[104px] shrink-0 rounded-full bg-slate-100 animate-pulse"
          />
        ) : (
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-sans text-[11px] font-medium leading-4 ${statusPill.wrap}`}
          >
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${statusPill.dot}`}
            />
            {statusText}
          </span>
        )}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <img
          src="/icons/plat.svg"
          alt=""
          aria-hidden
          className="h-9 w-9 shrink-0 rounded-full object-contain"
        />
        {loading ? (
          <span className="inline-block h-[34px] w-[150px] rounded-md bg-slate-100 animate-pulse" />
        ) : (
          <p
            className={`font-display text-[30px] sm:text-[34px] font-bold leading-none transition-colors duration-500 ${
              valueFlash === "up"
                ? "text-[#111827]"
                : valueFlash === "down"
                ? "text-[#111827]"
                : "text-[#111827]"
            }`}
          >
            {balanceText}
            <span className="ml-2.5 align-baseline font-sans text-[14px] sm:text-[15px] font-normal text-[#6B7280]">
              PLAT
            </span>
          </p>
        )}
      </div>

      {/* Amount field. Its surrounding mt-6 values match the card padding. */}
      <div className="mt-6 min-h-[90px] rounded-xl border border-[#DDE7EF] bg-[#FBFDFF] px-3 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] sm:min-h-[104px] sm:px-5 sm:py-5">
        <div className="mb-2">
          <span className="font-sans text-[12px] font-semibold leading-[18px] text-[#6B7280]">
            {inputLabel}
          </span>
        </div>
        {/* items-baseline so the MAX/All button's text sits on the same
            baseline as the "PLAT" unit beside the amount, rather than
            centred against the tall number. */}
        <div className="mt-1 flex min-w-0 max-w-full items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-1.5">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              const sanitized = sanitizeDecimalInput(e.target.value, 2);
              // Clamp at PLAT's total supply ceiling, mirroring the
              // original Stake/Unstake inputs.
              const n = parseFloat(sanitized);
              if (Number.isFinite(n) && n > PLAT_TOTAL_SUPPLY) {
                onAmountChange(String(PLAT_TOTAL_SUPPLY));
                return;
              }
              onAmountChange(sanitized);
            }}
            placeholder="0.00"
            disabled={inputDisabled}
            // `field-sizing: content` shrinks the input to the typed value's
            // width so the "PLAT" unit sits flush beside it — the same
            // inline-suffix pattern as the Exchange amount fields. `size`
            // gives the placeholder its width before the user types.
            size={amount === "" ? 4 : 1}
            className="m-0 max-w-full border-0 bg-transparent p-0 text-[24px] font-display font-semibold leading-none text-[var(--ex-text)] placeholder:text-[var(--ex-text-subtle)] focus:outline-none disabled:cursor-not-allowed sm:text-[28px] [field-sizing:content]"
          />
          <span className="shrink-0 font-display font-normal leading-none text-[var(--ex-text-muted)] text-[14px] sm:text-[16px]">
            PLAT
          </span>
          </div>
          {!loading && onMax ? (
            <button
              type="button"
              onClick={onMax}
              className="shrink-0 font-sans text-[12px] font-semibold leading-[18px] text-[#0284C7] underline underline-offset-2 hover:text-[#3EB7ED]"
            >
              {maxLabel}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className={buttonClass}
        >
          {busy ? "Processing…" : buttonLabel}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Reward card (right rail, top)
// ─────────────────────────────────────────────────────────────────────

function RewardCard({
  pendingRewards,
  claimable,
  claiming,
  onClaim,
  hasDeposit,
  loading = false,
}: {
  pendingRewards: number;
  claimable: boolean;
  claiming: boolean;
  onClaim: () => void;
  hasDeposit: boolean;
  /**
   * When true, the pending-rewards number is replaced with a pulsing
   * skeleton. Everything else (gradient bg, title, "Claim Reward"
   * button) stays painted — same approach as Exchange's BalanceHeroCard.
   */
  loading?: boolean;
}) {
  const showSubMessage = !loading && !claimable;
  const subMessage = hasDeposit
    ? `Earn at least ${MIN_CLAIM_REWARDS_PLAT} PLAT to claim your reward.`
    : "Deposit PLAT to start earning rewards.";

    return (
        <div
      className="relative min-h-[240px] overflow-hidden rounded-[10px] px-9 py-0 text-white shadow-sm ring-1 ring-inset ring-white/80"
      style={{
        background:
          "linear-gradient(90deg, #011017 0%, #08638C 50%, #3EB7ED 100%)",
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 z-0 rounded-[9px] backdrop-blur-[100px] opacity-50"
        style={{
          background:
            "linear-gradient(62deg, rgba(255,255,255,0.35) -54%, rgba(255,255,255,0.01) 100%)",
          backgroundSize: "150% 150%",
          backgroundPosition: "left center",
        }}
      />

      <img
        src="/icons/staking-reward-chart.svg"
        alt=""
        aria-hidden
        className="pointer-events-none absolute bottom-6 right-5 top-7 z-0 h-[calc(100%-52px)] w-[210px] object-contain object-right opacity-55 sm:right-6"
      />

      <div className="relative z-10 flex min-h-[240px] flex-col pt-9">
        <div>
          <p className="text-[16px] leading-none text-white/90">
            {pendingRewards > 0 ? "Reward ready to collect:" : "Rewards ready to collect:"}
          </p>

          <p className="mt-7 inline-flex items-baseline gap-2 font-sans font-weight: 700 text-[38px] font-bold leading-[42px] tracking-normal text-white">
            {loading ? (
              // Skeleton sized to roughly match the rendered number's
              // footprint, kept inline with the PLAT suffix so the
              // baseline doesn't shift when real data arrives.
              <span className="inline-block h-[38px] w-[120px] rounded-md bg-white/10 animate-pulse" />
            ) : (
              <span>
                {pendingRewards.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            )}
            <span className="font-sans text-[14px] font-normal leading-[22px] text-white/90">
              PLAT
            </span>
          </p>

          {showSubMessage && (
            <p className="mt-1 text-[16px] leading-[22px] text-white">
              {subMessage}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClaim}
          disabled={!claimable}
          title={!claimable ? subMessage : undefined}
          className={
            claimable
              ? "mt-8 h-[38px] w-[244px] rounded-[4px] bg-white text-[14px] font-semibold text-[#4B5563] shadow-sm transition-colors hover:bg-white/90"
              : "mt-8 h-[38px] w-[244px] rounded-[4px] bg-white/35 text-[14px] font-semibold text-[#566172] cursor-not-allowed"
          }
        >
          {claiming ? "Claiming…" : "Claim Reward"}
        </button>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────
// Stat card (right rail, lower)
// ─────────────────────────────────────────────────────────────────────

function StatCard({
  iconSrc,
  title,
  value,
  token,
  usdAnnotation,
  caption,
  loading = false,
}: {
  iconSrc: string;
  title: string;
  /**
   * Big amount line. Pass `null` (or omit) to skip the value paragraph
   * entirely — useful for empty-state cards where the caption alone
   * conveys the message and a placeholder "—" would just take up
   * space awkwardly between the title and caption.
   */
  value?: string | null;
  token?: string;
  /**
   * Optional muted annotation rendered after the token — used for the
   * "($X.XX USD)" suffix on reward-projection cards. Omit when the
   * card has no fiat equivalent.
   */
  usdAnnotation?: string;
  caption: string;
  /**
   * When true, the value AND caption are replaced with skeletons.
   * Caption is included because its text changes based on the value
   * being there or not — rendering the empty-state caption ("No
   * PLAT is currently deposited") while we don't yet know would
   * be misleading.
   */
  loading?: boolean;
}) {
  const hasValue = value != null && value !== "";
  return (
    <div
      className={
        // Reserve a consistent height while loading so the card doesn't
        // pop when real data arrives. Kept compact (vs the old 120px) so
        // the rail isn't taller than it needs to be — a shorter rail means
        // the form column stretches less, tightening the gap between each
        // box's divider and its CTA.
        loading || hasValue
          ? "ex-card flex min-h-[104px] items-center justify-between gap-4 px-6 py-3.5"
          : "ex-card flex items-center justify-between gap-4 px-6 py-3.5"
      }
    >
      <div className="min-w-0 flex-1">
        <p className="font-sans text-[16px] font-medium leading-[22px] text-[#374151]">
          {title}
        </p>

        {loading ? (
          <>
            {/* Value placeholder, sized to the rendered number+token line. */}
            <div className="mt-1.5 h-6 w-32 rounded-md bg-slate-100 animate-pulse" />
            {/* Caption placeholder — the real caption text varies by state. */}
            <div className="mt-1.5 h-3 w-48 rounded bg-slate-100 animate-pulse" />
          </>
        ) : (
          <>
            {hasValue && (
              <p className="mt-1.5 font-sans text-[20px] font-semibold leading-[24px] text-[#4B5563]">
                {value}
                {token && (
                  <span className="ml-1 align-baseline font-sans text-[14px] font-normal leading-[20px] text-[#4B5563]">
                    {token}
                  </span>
                )}
                {usdAnnotation && (
                  <span className="ml-1.5 align-baseline font-sans text-[13px] font-normal leading-[20px] text-[#6B7280]">
                    {usdAnnotation}
                  </span>
                )}
              </p>
            )}

            <p className="mt-1.5 font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
              {caption}
            </p>
          </>
        )}
      </div>

      <img
        src={iconSrc}
        alt=""
        aria-hidden
        className="mt-1 h-[26px] w-[26px] shrink-0 self-start object-contain"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Recent activity table
// ─────────────────────────────────────────────────────────────────────

function RecentActivityTable({
  orders,
  onSeeAll,
  total,
  loading = false,
}: {
  orders: StakingOrder[];
  onSeeAll: () => void;
  total: number | null;
  /**
   * When true, the table area renders pulsing skeleton rows (with
   * header) instead of the real list / empty state. The title is
   * always shown so the section keeps its anchor on the page.
   */
  loading?: boolean;
}) {
  // Convert the raw StakingOrder rows into the unified DashboardActivity
  // shape so we can drop them into the shared ActivityTable used by the
  // Dashboard. Same kind/icon/status/txHash mapping as
  // `app/actions/dashboard.ts`'s server-side merge, kept in sync here for
  // the inline preview (the "See all" modal already pulls from the
  // server with `filter="staking"` and uses the same renderer).
  // Inline preview caps at 4 rows; "See all" opens the modal with up
  // to 50 rows of full history. `flatMap` because an unstake with
  // non-zero rewards produces two rows (principal + collected rewards),
  // so we expand from raw orders, then slice to 4 to honor the cap.
  // EMPTY STATE FUNCTION - recent activity - const activities: DashboardActivity[] = [];

  const activities = orders.flatMap(stakingOrderToActivity).slice(0, 4);

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-[18px] sm:text-[24px] text-[#4B5563] font-semibold">
          Recent activity
        </h2>
        <div className="flex items-center gap-3">
          {!loading && total != null && total > 0 && (
            <span className="hidden sm:inline text-xs text-[var(--ex-text-muted)]">
              Showing {Math.min(activities.length, total)} of {total} items
            </span>
          )}
          {!loading && orders.length > 4 && (
            <button
              type="button"
              onClick={onSeeAll}
              className="seeall-recentactivity text-xs font-medium px-4 py-1.5 border-1 border-transparent rounded-[4px] text-white bg-[#0EA5E9] transition-colors cursor-pointer"
            >
              See all
            </button>
          )}
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
      ) : activities.length > 0 ? (
        <>
          <div className="md:hidden">
            <CompactActivityList rows={activities} />
          </div>
          <div className="hidden md:block">
            <ActivityTable rows={activities} loading={false} />
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

          <div className="flex min-h-[112px] items-center justify-center gap-5 px-6 py-7 border-t border-[#E5E7EB] bg-white">
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
  );
}

/**
 * Map a raw on-chain staking order into the unified DashboardActivity
 * shape rendered by the shared ActivityTable. Mirrors the server-side
 * mapper in `app/actions/dashboard.ts`'s `loadActivity`.
 *
 * Returns an array because an unstake with non-zero rewards is split
 * into two rows: the principal "Withdraw Deposit" + a separate
 * "Collect Rewards" entry. The on-chain `unstakeFor` releases both
 * in one tx — splitting keeps the Amount column clean and gives the
 * reward portion its own sparkle icon.
 */
function stakingOrderToActivity(o: StakingOrder): DashboardActivity[] {
  const principal = parseFloat(o.amount || "0");
  const reward = parseFloat(o.reward_amount || "0");
  const txHash = o.operator_tx_hash ?? null;
  // Staking contract lives on Base mainnet — always "base" when we have a hash.
  const txChain: "base" | null = txHash ? "base" : null;
  const status = mapInlineStakingStatus(o.status);

  switch (o.order_type) {
    case "stake":
      return [
        {
          id: `staking:${o.order_id}`,
          kind: "stake",
          title: "Deposit to Rewards Pool",
          // Tokens LEAVING the wallet into the staking contract —
          // paid-only row, "—" in the Received column.
          paidLabel: `- ${formatTokenAmount(principal)} PLAT`,
          receivedLabel: null,
          amountTone: "neutral",
          createdAt: o.created_at,
          status,
          txHash,
          txChain,
        },
      ];
    case "unstake": {
      const rows: DashboardActivity[] = [
        {
          id: `staking:${o.order_id}`,
          kind: "unstake",
          title: "Withdraw Deposit",
          paidLabel: null,
          receivedLabel: `+ ${formatTokenAmount(principal)} PLAT`,
          amountTone: "positive",
          createdAt: o.created_at,
          status,
          txHash,
          txChain,
        },
      ];
      if (reward >= DUST_REWARD_THRESHOLD) {
        rows.push({
          id: `staking:${o.order_id}:reward`,
          kind: "reward",
          title: "Collect Rewards",
          paidLabel: null,
          receivedLabel: `+ ${formatTokenAmount(reward)} PLAT`,
          amountTone: "positive",
          createdAt: o.created_at,
          status,
          txHash,
          txChain,
        });
      }
      return rows;
    }
    case "claim":
      return [
        {
          id: `staking:${o.order_id}`,
          kind: "reward",
          title: "Collect Rewards",
          paidLabel: null,
          receivedLabel: `+ ${formatTokenAmount(reward > 0 ? reward : principal)} PLAT`,
          amountTone: "positive",
          createdAt: o.created_at,
          status,
          txHash,
          txChain,
        },
      ];
    case "emergency_withdraw":
    default:
      return [
        {
          id: `staking:${o.order_id}`,
          kind: "unstake",
          title: "Emergency Withdrawal",
          paidLabel: null,
          receivedLabel: `+ ${formatTokenAmount(principal)} PLAT`,
          amountTone: "neutral",
          createdAt: o.created_at,
          status,
          txHash,
          txChain,
        },
      ];
  }
}

function mapInlineStakingStatus(
  s: string
): "success" | "pending" | "failed" | "cancelled" {
  if (s === "completed") return "success";
  if (s === "failed") return "failed";
  // Staking has no cancellation flow, so "cancelled" is never emitted —
  // the wider return type just keeps the shape compatible with the
  // shared DashboardActivity union.
  return "pending";
}

// ─────────────────────────────────────────────────────────────────────
// Emergency confirm modal
// ─────────────────────────────────────────────────────────────────────

function EmergencyConfirmModal({
  stakedAmount,
  pendingRewards,
  onCancel,
  onConfirm,
}: {
  stakedAmount: number;
  pendingRewards: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 border border-[var(--ex-border)]">
        <h3 className="text-lg font-semibold text-[var(--ex-text)]">
          Confirm emergency withdrawal
        </h3>
        <p className="mt-2 text-sm text-[var(--ex-text-muted)]">
          This will withdraw your entire deposit of{" "}
          <span className="font-semibold text-[var(--ex-text)]">
            {formatTokenAmount(stakedAmount)} PLAT
          </span>{" "}
          immediately, but you will{" "}
          <span className="font-semibold text-red-600">
            forfeit all accrued rewards
          </span>{" "}
          ({formatTokenAmount(pendingRewards)} PLAT).
        </p>
        <p className="mt-2 text-xs text-amber-700">This action cannot be undone.</p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-[var(--ex-surface-muted)] text-[var(--ex-text)] border border-[var(--ex-border)] hover:bg-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
          >
            Confirm withdrawal
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────


function formatLockStatus(lockUntil: number): { text: string; locked: boolean } {
  if (lockUntil === 0) return { text: "No active deposit", locked: false };
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = lockUntil - nowSec;
  if (remaining <= 0) return { text: "Unlocked", locked: false };
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const text =
    days > 0
      ? `Locked for ${days}d ${hours}h`
      : `Locked for ${hours}h ${Math.floor((remaining % 3600) / 60)}m`;
  return { text, locked: true };
}

function sanitizeDecimalInput(value: string, maxDecimals = 2): string {
  const raw = value.replace(/[^\d.]/g, "");
  const parts = raw.split(".");
  const whole = parts[0] ?? "";

  let sanitized =
    parts.length > 2 ? `${whole}.${parts.slice(1).join("")}` : raw;

  if (sanitized.includes(".")) {
    const [integerPart, decimalPart = ""] = sanitized.split(".");
    sanitized = `${integerPart}.${decimalPart.slice(0, maxDecimals)}`;
  }

  // Normalize leading zeros on the integer part so "010" → "10" and a
  // long zero string ("00000…0") collapses to "0". Keeps "0" when the
  // integer is empty/all-zeros so "0.5" stays "0.5" and a bare "0"
  // remains valid while typing. Also normalizes ".5" → "0.5".
  if (sanitized !== "") {
    const [intPart, ...restParts] = sanitized.split(".");
    const hadDecimal = restParts.length > 0;
    const normalizedInt = intPart.replace(/^0+/, "") || "0";
    sanitized = hadDecimal
      ? `${normalizedInt}.${restParts.join("")}`
      : normalizedInt;
  }

  return sanitized;
}

function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Largest 2-decimal value that is still ≤ n. Used so the displayed balance
// and the MAX shortcut agree (never show more than the user can act on) and
// to absorb the float noise from on-chain 18-decimal amounts. Mirrors the
// helper of the same name in components/Exchange.tsx.
function floorToCents(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.round(n * 100) / 100;
  if (rounded <= n) return rounded;
  return Math.max(0, (Math.round(n * 100) - 1) / 100);
}


// ─────────────────────────────────────────────────────────────────────
// Inline icons
// ─────────────────────────────────────────────────────────────────────

function ArrowDownTray() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v10m0 0-4-4m4 4 4-4M4 18h16" />
    </svg>
  );
}
function ArrowUpTray() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V6m0 0L8 10m4-4 4 4M4 20h16" />
    </svg>
  );
}
function CoinsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <ellipse cx="9" cy="7" rx="6" ry="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7M3 11v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4" />
      <ellipse cx="15" cy="14" rx="6" ry="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 14v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4" />
    </svg>
  );
}
function PlantIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 20v-7m0 0c-3 0-5-2-5-5 3 0 5 2 5 5zm0 0c3 0 5-2 5-5-3 0-5 2-5 5z" />
      <path strokeLinecap="round" d="M7 20h10" />
    </svg>
  );
}
function ChartArtwork({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" fill="none">
      {/* Bars */}
      <rect x="14" y="60" width="10" height="30" rx="2" fill="currentColor" />
      <rect x="30" y="48" width="10" height="42" rx="2" fill="currentColor" opacity="0.6" />
      <rect x="46" y="38" width="10" height="52" rx="2" fill="currentColor" opacity="0.4" />
      <rect x="62" y="26" width="10" height="64" rx="2" fill="currentColor" opacity="0.25" />
      <rect x="78" y="14" width="10" height="76" rx="2" fill="currentColor" opacity="0.15" />
      {/* Arrow */}
      <path
        d="M12 64 L42 44 L62 50 L92 18"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M85 14 L92 18 L88 25" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
