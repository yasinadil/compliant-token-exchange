// components/Exchange.tsx
"use client";

// Unified Exchange UI ("Def" design from Figma).
// One shell, three tabs:
//
//   • Buy               → fiat → PLAT via Transak on-ramp (card,
//                         Apple/Google Pay, bank transfer — depending on
//                         what Transak surfaces in the checkout)
//   • Sell Tokens       → PLAT token → fiat via Transak off-ramp (cashout)
//   • Convert Tokens    → PLAT token ↔ PLAT token via the internal ledger swap
//
// Web3 / on-ramp / off-ramp / swap logic is NOT reimplemented here — each
// form delegates to the existing server actions in app/actions/. Only the
// presentation layer is new.
//
// Right-side rail:
//   • PLAT balance hero card with currency selector
//   • Recent activity (mirrors the dashboard feed, capped at 4 rows)

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

import {
  getDashboardSnapshot,
  getFullActivityAction,
  getActivityCountAction,
  type DashboardActivity,
  type DashboardActivityKind,
  type DashboardSnapshot,
} from "@/app/actions/dashboard";
import {
  ActivityTable,
  TransactionHistoryModal,
  formatActivityAmount,
} from "@/components/ActivityHistory";
import { ToastViewport, type Toast } from "@/components/Toast";
import { randomId } from "@/app/lib/client-id";
import { ModalCloseButton } from "@/components/ModalCloseButton";
import { ActivityTableSkeleton } from "@/components/Skeletons";
import { MobilePrimaryNav } from "@/components/AppShell";
import {
  getBuyQuote,
  createBuyOrderAction,
  pollActivePaymentAction,
  getTradeOrderStatus,
  getMyTradeHistory,
  cancelBuyOrderAction,
} from "@/app/actions/trade-orders";
import {
  createStableTopUpAction,
  getStableTopUpQuote,
  pollOnRampByPartnerOrderId,
  getOrderStatus as getOnRampOrderStatusAction,
  getMyOnRampHistory,
  cancelStableTopUpAction,
} from "@/app/actions/onramp";
import {
  getCashoutQuoteAction,
  initiateCashoutTransakAction,
  processWalletRedirectionAction,
  getCashoutStatusAction,
  reconcileAwaitingCashouts,
  cancelAwaitingTransakCashoutAction,
  getMyCashoutHistory,
} from "@/app/actions/cashout";
import {
  getQuote as getSwapQuoteAction,
  executeSwapAction,
  getConvertQuoteAction,
  executeConvertAction,
} from "@/app/actions/swap";
import {
  TRANSAK_LITE_MAX_PER_CURRENCY,
  TRANSAK_MIN_PER_CURRENCY,
} from "@/app/lib/transak-limits";

// ─────────────────────────────────────────────────────────────────────
// Types & shared metadata
// ─────────────────────────────────────────────────────────────────────

export type ExchangeMode = "buy" | "sell" | "swap";

const FIAT_OPTIONS = ["USD", "EUR", "GBP", "BRL"] as const;
type FiatCurrency = (typeof FIAT_OPTIONS)[number];

// Long-form fiat names. Used as the row label inside CurrencyDropdown's
// popover where there's room — keeps stablecoin "USDX" (the token)
// from looking like "USD" (the currency) when both appear on the same
// screen. The trigger button still shows the compact ISO code so it
// fits in the field shell.
const FIAT_FULL_NAMES: Record<FiatCurrency, string> = {
  USD: "U.S. Dollar",
  EUR: "Euro",
  GBP: "British Pound",
  BRL: "Brazilian Real",
};

// Display symbol shown as a prefix adornment inside amount inputs (e.g.
// "$100", "€100"). Brazilian real uses the two-character "R$" form.
const FIAT_SYMBOLS: Record<FiatCurrency, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  BRL: "R$",
};

type TokenSymbol = "PLAT" | "USDX" | "EURX" | "GBPX" | "BRLX";

const TOKEN_DISPLAY_NAMES: Record<TokenSymbol, string> = {
  PLAT: "PLAT",
  USDX: "PLAT Dollar (USDX)",
  EURX: "PLAT Euro (EURX)",
  GBPX: "PLAT Pound (GBPX)",
  BRLX: "PLAT Real (BRLX)",
};

const TOKEN_BALANCE_NAMES: Record<TokenSymbol, string> = {
  PLAT: "PLAT",
  USDX: "PLAT Dollar",
  EURX: "PLAT Euro",
  GBPX: "PLAT Pound",
  BRLX: "PLAT Real",
};

const BUY_PROCESSING_FEE_TOOLTIP =
  "This fee helps process your payment and is charged by Transak, not Exchange.";
const BUY_PRICE_EFFECT_TOOLTIP =
  "Larger purchases can affect the PLAT price. This estimate shows the expected impact before you continue.";

/**
 * In-flight convert (both AMM and stable↔stable paths). Set by
 * ConvertForm around its execute await, derived into a persistent
 * "Conversion in progress" toast by the parent Exchange component.
 * Stable↔stable runs sub-second so the banner is a brief flash —
 * intentional, for UX consistency with the Buy and Sell in-flight
 * banners.
 */
type ActiveConvert = {
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  fromAmount: string;
  toAmount: string;
};

//iconos tokens
function tokenIconSrc(token: TokenSymbol): string {
  const map: Record<TokenSymbol, string> = {
    PLAT: "/icons/plat.svg",
    USDX: "/icons/usdx.svg",
    EURX: "/icons/eurx.svg",
    GBPX: "/icons/gbpx.svg",
    BRLX: "/icons/brlx.svg",
  };

  return map[token];
}

// iconos fiat
function fiatIconSrc(currency: FiatCurrency): string {
  const map: Record<FiatCurrency, string> = {
    USD: "/icons/usdx.svg",
    EUR: "/icons/eurx.svg",
    GBP: "/icons/gbpx.svg",
    BRL: "/icons/brlx.svg",
  };

  return map[currency];
}

const BUY_BALANCE_TOKENS: TokenSymbol[] = [
  "PLAT",
  "USDX",
  "GBPX",
  "EURX",
  "BRLX",
];

interface ExchangeProps {
  initialMode: ExchangeMode;
}

// Live selection + rate pushed up from the Buy / Sell / Convert forms so
// the right-rail exchange-rate card can mirror what the user is doing.
// `token` is the PLAT token on the "you receive" side (Buy) or the "you
// sell"/"you convert" side (Sell / Convert).
//
// The right-hand side of the rate pill is either a fiat currency (Buy /
// Sell) or another token (Convert):
//   • Buy / Sell  → rate = 1 token = `rate` fiat   (quoteToken omitted)
//   • Convert     → rate = 1 token = `rate` quoteToken
// When `quoteToken` is set the card renders token→token and ignores
// `fiatCurrency`.
type RateCardContext = {
  token: TokenSymbol;
  fiatCurrency: FiatCurrency;
  rate: number | null;
  loadingRate: boolean;
  quoteToken?: TokenSymbol;
};

// ─────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────

export default function Exchange({ initialMode }: ExchangeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<ExchangeMode>(initialMode);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [buySidebar, setBuySidebar] = useState<RateCardContext>({
    token: "PLAT",
    fiatCurrency: "USD",
    rate: null,
    loadingRate: true,
  });
  const [sellSidebar, setSellSidebar] = useState<RateCardContext>({
    token: "PLAT",
    fiatCurrency: "USD",
    rate: null,
    loadingRate: true,
  });
  // Convert's rate card is token→token, so it carries a `quoteToken`.
  // Defaults mirror ConvertForm's initial from/to (USDX → EURX).
  const [convertSidebar, setConvertSidebar] = useState<RateCardContext>({
    token: "USDX",
    quoteToken: "EURX",
    fiatCurrency: "USD",
    rate: null,
    loadingRate: true,
  });
  // Transient toasts (post-action / Transak return). The in-flight order
  // indicators below are derived as persistent toasts at render time, so
  // they don't live in this array.
  const [transientToasts, setTransientToasts] = useState<Toast[]>([]);

  const pushToast = (t: Omit<Toast, "id">) => {
    setTransientToasts((prev) => [
      ...prev,
      { ...t, id: randomId() },
    ]);
  };
  const dismissToast = (id: string) => {
    setTransientToasts((prev) => prev.filter((t) => t.id !== id));
  };
  // Active in-flight cashout we should poll for status updates. Mirrors
  // the legacy CashoutForm's `activeCashout` state — without this the
  // user wouldn't see "crypto sent" / "completed" transitions.
  const [activeCashout, setActiveCashout] = useState<
    | {
        cashoutId: string;
        status: string;
        /**
         * Original token the user sold (USDX / EURX / GBPX / BRLX
         * / PLAT). Used to render the right refund-token name in
         * the cancellation banner — PLAT refunds come back as
         * USDX because the AMM swap is already on-chain by the time
         * the order reaches `awaiting_transak`.
         */
        sourceToken?: string;
      }
    | null
  >(null);
  // Active in-flight buy order. Mirrors the legacy TradeTGlobal's
  // `activeOrder` polling — on localhost the Transak webhook can't reach
  // us, so we have to call `pollActivePaymentAction` on a timer to credit
  // PLAT once payment completes. Without this the user has to click
  // "Check payment status" on the old Trade page (the bug we're fixing).
  //
  // Two flavours:
  //   • kind: "trade"  → PLAT purchase via createBuyOrderAction (goes
  //     through the AMM). Polled with pollActivePaymentAction +
  //     getTradeOrderStatus by `orderId`.
  //   • kind: "stable" → stablecoin top-up via createStableTopUpAction (no AMM,
  //     possibly chained with a USDX→target ledger swap). Polled with
  //     pollOnRampByPartnerOrderId + getOnRampOrderStatusAction by
  //     `partnerOrderId`. `targetToken` is what the user picked so the
  //     completion toast can show the right token name.
  type ActiveBuyOrder =
    | { kind: "trade"; orderId: string; status: string }
    | {
        kind: "stable";
        partnerOrderId: string;
        targetToken: TokenSymbol;
        status: string;
      };
  const [activeBuyOrder, setActiveBuyOrder] = useState<ActiveBuyOrder | null>(
    null
  );
  // Active convert order. Set by ConvertForm around its execute await so
  // the user sees a persistent "Conversion in progress" banner for both
  // AMM (5–30 s on-chain) and stable↔stable (sub-second ledger) paths —
  // standardised for UX consistency with the Buy / Sell banners, even
  // though the ledger path's banner is just a brief flash. State lives
  // here (mirrors activeCashout / activeBuyOrder) so the persistent toast
  // can be derived alongside the others.
  const [activeConvert, setActiveConvert] = useState<ActiveConvert | null>(
    null
  );
  // Lazy-loaded full activity for the "See all" modal — filtered to
  // Exchange-only on this surface so staking rows never leak in.
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [fullActivity, setFullActivity] = useState<DashboardActivity[] | null>(null);
  const [fullActivityLoading, setFullActivityLoading] = useState(false);
  // Exchange-only transaction count for the "Showing N of X" hint.
  const [activityTotal, setActivityTotal] = useState<number | null>(null);
  // One-shot guard so the wallet-redirection handler doesn't double-fire
  // in StrictMode dev or when the searchParams object identity churns.
  const transakRedirectHandled = useRef(false);
  const reconcileRan = useRef(false);

  // Sync mode → URL so refresh / share keeps the active tab.
  // Mode is local UI state. Keep the shareable query in sync without
  // starting a new App Router render while the snapshot request is pending.
  useEffect(() => {
    const current = searchParams?.get("mode");
    if (current === mode) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("mode", mode);
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}?${params.toString()}`
    );
  }, [mode, pathname, searchParams]);

  // Imperative refresher passed to the forms so a successful submit can
  // re-pull balances + activity AND pick up any new in-flight cashout
  // so the polling effect starts in the original tab. The initial load
  // happens in the effect below — keeping the call site there avoids
  // the react-hooks/set-state-in-effect rule that triggers on memoized
  // closures that wrap setState.
  const loadSnapshot = async () => {
    const [snapRes, cashoutHist, tradeHist, onrampHist] = await Promise.all([
      getDashboardSnapshot("exchange"),
      getMyCashoutHistory(20, 0),
      getMyTradeHistory(20, 0),
      getMyOnRampHistory(20),
    ]);
    if (snapRes.success) {
      setSnapshot(snapRes.data);
      setSnapshotError(null);
    } else {
      setSnapshotError(snapRes.error);
    }
    if (cashoutHist.success) {
      const IN_FLIGHT = ["processing", "awaiting_transak", "crypto_sent"];
      const inflight = cashoutHist.data.find((o) => IN_FLIGHT.includes(o.status));
      if (inflight) {
        // Only set if we don't already have a different in-flight order
        // — don't clobber an active poll that's already running.
        setActiveCashout((prev) =>
          prev
            ? prev
            : {
                cashoutId: inflight.cashout_id,
                status: inflight.status,
                sourceToken: inflight.token,
              }
        );
      }
    }
    if (tradeHist.success) {
      // Mirror the legacy TradeTGlobal in-flight set. Anything still
      // pending or mid-processing should be polled until terminal.
      const IN_FLIGHT_TRADE = [
        "pending_payment",
        "payment_received",
        "processing",
      ];
      const inflight = tradeHist.data.find(
        (o) => o.order_type === "buy" && IN_FLIGHT_TRADE.includes(o.status)
      );
      if (inflight) {
        setActiveBuyOrder((prev) =>
          prev
            ? prev
            : { kind: "trade", orderId: inflight.order_id, status: inflight.status }
        );
      }
    }
    if (onrampHist.success && onrampHist.orders) {
      const IN_FLIGHT_ONRAMP = ["pending", "processing"];
      const inflight = onrampHist.orders.find(
        (o) =>
          o.target_token &&
          o.partner_order_id &&
          IN_FLIGHT_ONRAMP.includes(o.status)
      );
      if (inflight && inflight.partner_order_id && inflight.target_token) {
        setActiveBuyOrder((prev) =>
          prev
            ? prev
            : {
                kind: "stable",
                partnerOrderId: inflight.partner_order_id!,
                targetToken: inflight.target_token as TokenSymbol,
                status: inflight.status,
              }
        );
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) Reconcile stale `awaiting_transak` orders. The legacy
      //    CashoutForm runs this on first mount — it auto-refunds users
      //    who started a cashout but never completed Transak.
      if (!reconcileRan.current) {
        reconcileRan.current = true;
        reconcileAwaitingCashouts().catch(() => {});
      }

      // 2) Initial dashboard snapshot (balances + activity) + the
      //    Exchange-only transaction count for the "Showing N of X" hint.
      const [res, countRes] = await Promise.all([
        getDashboardSnapshot("exchange"),
        getActivityCountAction(),
      ]);
      if (cancelled) return;
      if (res.success) {
        setSnapshot(res.data);
        setSnapshotError(null);
      } else {
        setSnapshotError(res.error);
      }
      if (countRes.success) setActivityTotal(countRes.data.exchange);

      // 3) Pick up any in-flight cashouts so the user sees the status
      //    banner / polling even after a refresh or new tab. Legacy
      //    parity: CashoutForm.loadData picks the first in-flight order
      //    out of the user's history.
      const IN_FLIGHT_CASHOUT = [
        "processing",
        "awaiting_transak",
        "crypto_sent",
      ];
      const IN_FLIGHT_TRADE = [
        "pending_payment",
        "payment_received",
        "processing",
      ];
      const [cashoutHist, tradeHist] = await Promise.all([
        getMyCashoutHistory(20, 0),
        getMyTradeHistory(20, 0),
      ]);
      if (cancelled) return;
      if (cashoutHist.success) {
        const inflight = cashoutHist.data.find((o) =>
          IN_FLIGHT_CASHOUT.includes(o.status)
        );
        if (inflight) {
          setActiveCashout({
            cashoutId: inflight.cashout_id,
            status: inflight.status,
            sourceToken: inflight.token,
          });
        }
      }
      if (tradeHist.success) {
        const inflight = tradeHist.data.find(
          (o) => o.order_type === "buy" && IN_FLIGHT_TRADE.includes(o.status)
        );
        if (inflight) {
          setActiveBuyOrder({
            kind: "trade",
            orderId: inflight.order_id,
            status: inflight.status,
          });
        }
      }

      // Pick up an in-flight stable top-up (standalone on-ramp with a
      // target_token set). Status set is the OnRampStatus enum from
      // transak-service: 'pending' before the user pays, 'processing' once
      // Transak has the payment, 'completed' once we've credited.
      const onrampHist = await getMyOnRampHistory(20);
      if (cancelled) return;
      if (onrampHist.success && onrampHist.orders) {
        const IN_FLIGHT_ONRAMP = ["pending", "processing"];
        const inflight = onrampHist.orders.find(
          (o) =>
            o.target_token &&
            o.partner_order_id &&
            IN_FLIGHT_ONRAMP.includes(o.status)
        );
        if (inflight && inflight.partner_order_id && inflight.target_token) {
          setActiveBuyOrder((prev) =>
            prev
              ? prev
              : {
                  kind: "stable",
                  partnerOrderId: inflight.partner_order_id!,
                  targetToken: inflight.target_token as TokenSymbol,
                  status: inflight.status,
                }
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the active cashout's status every 15s — same cadence as the
  // legacy CashoutForm. Surfaces "crypto sent" / "completed" / "failed"
  // transitions to the user without requiring a manual refresh.
  useEffect(() => {
    if (!activeCashout?.cashoutId) return;
    const cashoutId = activeCashout.cashoutId;

    let cancelled = false;
    const tick = async () => {
      const res = await getCashoutStatusAction(cashoutId);
      if (cancelled || !res.success) return;
      const { status } = res.data;
      setActiveCashout((prev) =>
        prev && prev.cashoutId === cashoutId ? { ...prev, status } : prev
      );

      if (status === "completed") {
        // Refresh balances + activity FIRST so the recent activity feed
        // updates the row from "Pending" to "Completed". Doing this
        // before `setActiveCashout(null)` matters: clearing activeCashout
        // tears down this polling effect, which sets `cancelled = true`
        // in the cleanup and would skip the snapshot update.
        const snap = await getDashboardSnapshot("exchange");
        if (snap.success) {
          setSnapshot(snap.data);
          setSnapshotError(null);
        }
        // Unlock the "Skip tutorial and proceed" shortcut on the next
        // sale. Strict-by-completion: a user only earns the skip after
        // a sale that fully reaches Transak's terminal `completed`
        // state, so anyone who bails mid-flow re-walks the tutorial.
        try {
          window.localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
        } catch {
          // Quota / private mode — silently ignore; worst case the
          // user sees the full tutorial again next time.
        }
        pushToast({
          variant: "success",
          title: "Sale complete",
          description: "Your funds have been sent to your bank by Transak.",
        });
        setActiveCashout(null);
      } else if (status === "failed") {
        pushToast({
          variant: "error",
          title: "Sale failed",
          description: res.data.failureReason || undefined,
        });
        setActiveCashout(null);
      }
    };
    // Fire once immediately, then every 15s.
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeCashout?.cashoutId]);

  // Poll the active BUY order. On localhost (and during webhook lag) the
  // Transak webhook can't credit on its own, so we fan-out a poll on a
  // short interval. Branches on `kind`:
  //   • trade  → PLAT purchase. Uses pollActivePaymentAction +
  //              getTradeOrderStatus.
  //   • stable → stablecoin top-up. Uses pollOnRampByPartnerOrderId +
  //              getOnRampOrderStatusAction. For non-USDX targets the
  //              backend chains a ledger swap after credit, so "complete"
  //              only fires once that swap (target_swap_transaction_id) is
  //              also set.
  useEffect(() => {
    if (!activeBuyOrder) return;

    const order = activeBuyOrder;
    let cancelled = false;
    const tick = async () => {
      if (order.kind === "trade") {
        const orderId = order.orderId;
        if (order.status === "pending_payment") {
          await pollActivePaymentAction(orderId).catch(() => {});
        }
        if (cancelled) return;
        const res = await getTradeOrderStatus(orderId);
        if (cancelled || !res.success) return;
        const { status, tglobalAmount } = res.data;

        setActiveBuyOrder((prev) =>
          prev && prev.kind === "trade" && prev.orderId === orderId
            ? { ...prev, status }
            : prev
        );

        if (status === "completed") {
          const snap = await getDashboardSnapshot("exchange");
          if (snap.success) {
            setSnapshot(snap.data);
            setSnapshotError(null);
          }
          pushToast({
            variant: "success",
            title: "Purchase complete",
            description: `${formatTokenAmount(
              parseFloat(tglobalAmount)
            )} PLAT credited to your balance.`,
          });
          setActiveBuyOrder(null);
        } else if (
          status === "price_changed" ||
          status === "insufficient_balance" ||
          status === "cancelled" ||
          status === "failed"
        ) {
          const titleMap: Record<string, string> = {
            price_changed: "Price moved",
            insufficient_balance: "Liquidity unavailable",
            cancelled: "Order cancelled",
            failed: "Order failed",
          };
          const descMap: Record<string, string> = {
            price_changed:
              "Price moved while your payment was processing. Your USDX has been returned to your balance.",
            insufficient_balance:
              "Insufficient liquidity at execution time. Your USDX has been returned to your balance.",
            cancelled: "",
            failed: res.data.failureReason || "",
          };
          pushToast({
            variant: status === "cancelled" ? "warning" : "error",
            title: titleMap[status],
            description: descMap[status] || undefined,
          });
          setActiveBuyOrder(null);
        }
        return;
      }

      // kind === "stable"
      const partnerOrderId = order.partnerOrderId;
      const targetToken = order.targetToken;

      // Always try the poll path — if Transak hasn't completed yet it's a
      // cheap no-op; if it has, this fires credit + post-credit swap.
      await pollOnRampByPartnerOrderId(partnerOrderId).catch(() => {});
      if (cancelled) return;

      const res = await getOnRampOrderStatusAction(partnerOrderId);
      if (cancelled || !res.success || !res.order) return;
      const { status, targetToken: rowTarget, targetSwapTransactionId } =
        res.order;

      setActiveBuyOrder((prev) =>
        prev && prev.kind === "stable" && prev.partnerOrderId === partnerOrderId
          ? { ...prev, status }
          : prev
      );

      // For non-USD targets we wait for BOTH the USDX credit (status =
      // 'completed') AND the post-credit ledger swap (target_swap_transaction_id
      // set) before declaring success — otherwise the user briefly sees USDX
      // in their balance before it flips to the chosen token.
      const swapNeeded = !!rowTarget && rowTarget !== "USDX";
      const swapDone = !!targetSwapTransactionId;
      const fullyComplete = status === "completed" && (!swapNeeded || swapDone);

      if (fullyComplete) {
        const snap = await getDashboardSnapshot("exchange");
        if (snap.success) {
          setSnapshot(snap.data);
          setSnapshotError(null);
        }
        pushToast({
          variant: "success",
          title: "Top-up complete",
          description: `${targetToken} credited to your balance.`,
        });
        setActiveBuyOrder(null);
      } else if (status === "failed" || status === "refunded") {
        pushToast({
          variant: status === "refunded" ? "warning" : "error",
          title: status === "refunded" ? "Payment refunded" : "Top-up failed",
          description:
            status === "refunded"
              ? "Transak refunded your payment — your card was not charged."
              : "The Transak payment did not complete. Please try again.",
        });
        setActiveBuyOrder(null);
      }
    };

    tick();
    const id = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Specific-field dependencies (not the whole object) so the interval
    // isn't torn down and recreated on every tick — setState inside `tick`
    // creates a new object reference each time even when only `status`
    // actually changes. Matches the dep-array shape from the pre-Option-3
    // version.
  }, [
    activeBuyOrder?.kind,
    activeBuyOrder?.status,
    activeBuyOrder?.kind === "trade" ? activeBuyOrder.orderId : null,
    activeBuyOrder?.kind === "stable" ? activeBuyOrder.partnerOrderId : null,
  ]);

  // Lazy-fetch the full Exchange-only activity feed the first time the
  // user opens the "See all" modal. Subsequent opens reuse the cache.
  // `setFullActivityLoading(true)` lives inside the IIFE to satisfy
  // React 19's react-hooks/set-state-in-effect rule. The guard depends
  // on `fullActivity` (not `fullActivityLoading`) so the in-flight
  // fetch isn't self-cancelled when the loading flag flips — same fix
  // that was needed on the Dashboard.
  useEffect(() => {
    if (!activityModalOpen || fullActivity) return;
    let cancelled = false;
    (async () => {
      setFullActivityLoading(true);
      const res = await getFullActivityAction("exchange");
      if (cancelled) return;
      setFullActivityLoading(false);
      if (res.success) setFullActivity(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [activityModalOpen, fullActivity]);

  // Handle the Transak SELL return redirect.
  //
  // After the user finishes the off-ramp KYC + bank flow, Transak
  // redirects to /exchange?mode=sell&transakDone=1&orderId=<partnerId>
  // with `walletAddress` (Transak's deposit address) and another
  // `orderId` (the Transak order id) appended. We hand that wallet
  // address to `processWalletRedirectionAction`, which makes the
  // operator send the crypto on the user's behalf — completing the
  // legacy "I've sent the payment" pattern automatically.
  //
  // All side-effecting setState happens inside the async IIFE so this
  // effect doesn't run setState synchronously on render.
  useEffect(() => {
    if (transakRedirectHandled.current) return;
    if (!searchParams) return;
    const done = searchParams.get("transakDone");
    const walletAddress = searchParams.get("walletAddress");
    const partnerOrderId = searchParams.get("partnerOrderId");
    const transakOrderId =
      searchParams.getAll("orderId").find((id) => id.includes("-")) ?? "";
    if (done !== "1" || !walletAddress || !partnerOrderId) return;

    transakRedirectHandled.current = true;

    // Strip the redirect params so a refresh doesn't try to re-process.
    const cleaned = new URLSearchParams(searchParams.toString());
    ["transakDone", "walletAddress", "partnerOrderId", "orderId"].forEach((k) =>
      cleaned.delete(k)
    );
    cleaned.set("mode", "sell");
    router.replace(`${pathname}?${cleaned.toString()}`, { scroll: false });

    (async () => {
      // Show an "in progress" toast immediately, but DO NOT set
      // activeCashout yet — that would kick off the polling effect's
      // first tick before the server-side wallet redirection finishes,
      // which can briefly surface a transient "failed" status.
      pushToast({
        variant: "info",
        title: "Finalizing sale",
        description: "Forwarding your funds to Transak…",
      });

      const result = await processWalletRedirectionAction(
        partnerOrderId,
        walletAddress,
        transakOrderId
      );
      if (result.success) {
        // The server has now sent the crypto from treasury → Transak.
        // Safe to start polling now. Status is `crypto_sent` or further.
        setActiveCashout({
          cashoutId: partnerOrderId,
          status: result.data.status,
          // Threading the original token through so the in-flight
          // cancellation modal can render token-aware copy (PLAT
          // refunds as USDX because the AMM swap is already on-chain;
          // every other token refunds in-kind).
          sourceToken: result.data.token,
        });
        pushToast({
          variant: "info",
          title: "Funds forwarded to Transak",
          description:
            "Waiting for Transak to confirm the payout — funds usually arrive in your bank in 1–2 business days.",
        });
        // Refresh balances + activity now that the cashout has progressed.
        const snap = await getDashboardSnapshot("exchange");
        if (snap.success) {
          setSnapshot(snap.data);
          setSnapshotError(null);
        }
      } else {
        setActiveCashout(null);
        pushToast({
          variant: "error",
          title: "Sale failed",
          description: result.error,
        });
      }
    })();
  }, [searchParams, pathname, router]);

  // Tracks whether an explicit "Cancel sale" click is in-flight so we
  // can disable the toast action button. Cleared inside `handleCancelSale`
  // once the server action resolves (success or error). Doesn't need to
  // persist across re-mounts — a cancel is a single-shot user gesture.
  const [cancellingCashout, setCancellingCashout] = useState(false);

  // Controls the in-flight "Reopen tutorial" modal. Distinct from
  // `confirmOpen` (the pre-checkout flow) — this one runs in reference
  // mode, with no Continue-to-Transak button, so it can't accidentally
  // kick off a second cashout while one is already running.
  const [referenceTutorialOpen, setReferenceTutorialOpen] = useState(false);

  // Confirmation dialog before firing the destructive Cancel-sale path.
  // The Cancel button on the in-flight toast no longer calls the server
  // directly — it opens this modal so the user can read the refund
  // explanation (token already converted to USDX for PLAT sales,
  // same-token refund otherwise) before committing.
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  // Buy-side analogues of the two pieces of cancel state above. The Buy
  // in-flight toast's "Cancel purchase" button opens a confirmation modal
  // (CancelBuyConfirmModal) rather than hitting the server directly, and
  // `cancellingBuy` disables the button while the cancel is in flight.
  // Unlike Sell there's no refund to explain — the user hasn't paid Transak
  // yet — so the modal copy is simpler.
  const [cancellingBuy, setCancellingBuy] = useState(false);
  const [cancelBuyConfirmOpen, setCancelBuyConfirmOpen] = useState(false);

  const handleCancelBuyOrder = async () => {
    if (!activeBuyOrder || cancellingBuy) return;
    setCancellingBuy(true);
    // Branch on the active order's flavour — PLAT trades carry an
    // `orderId` and cancel via the trade lifecycle; stable top-ups carry a
    // `partnerOrderId` and cancel via the on-ramp lifecycle. Both server
    // actions share the same Transak-status guard, so a payment Transak is
    // already processing comes back as an error we surface verbatim.
    const res =
      activeBuyOrder.kind === "trade"
        ? await cancelBuyOrderAction(activeBuyOrder.orderId)
        : await cancelStableTopUpAction(activeBuyOrder.partnerOrderId);
    setCancellingBuy(false);
    setCancelBuyConfirmOpen(false);
    if (!res.success) {
      pushToast({
        variant: "error",
        title: "Cancel failed",
        description: res.error,
      });
      return;
    }
    // Refresh the snapshot BEFORE clearing activeBuyOrder — clearing tears
    // down the polling effect's cleanup, which would cancel this in-flight
    // fetch (same ordering rule as handleCancelSale).
    const snap = await getDashboardSnapshot("exchange");
    if (snap.success) {
      setSnapshot(snap.data);
      setSnapshotError(null);
    }
    pushToast({
      variant: "success",
      title: "Purchase cancelled",
      description: "Your order was cancelled. You weren't charged.",
    });
    setActiveBuyOrder(null);
  };

  const handleCancelSale = async () => {
    if (!activeCashout?.cashoutId || cancellingCashout) return;
    const id = activeCashout.cashoutId;
    setCancellingCashout(true);
    const res = await cancelAwaitingTransakCashoutAction(id);
    setCancellingCashout(false);
    setCancelConfirmOpen(false);
    if (!res.success) {
      pushToast({
        variant: "error",
        title: "Cancel failed",
        description: res.error,
      });
      return;
    }
    // Refresh snapshot + activity so the refunded balance + new "Refund
    // received" row land immediately. Doing this BEFORE clearing
    // activeCashout matters for the same reason as the polling-success
    // path: clearing tears down the polling effect's cleanup, which
    // would cancel the in-flight snapshot fetch via the `cancelled` flag.
    const snap = await getDashboardSnapshot("exchange");
    if (snap.success) {
      setSnapshot(snap.data);
      setSnapshotError(null);
    }
    pushToast({
      variant: "success",
      title: "Sale cancelled",
      description: "Your tokens have been refunded to your balance.",
    });
    setActiveCashout(null);
  };

  // Collapsible toasts derived from in-flight order state. Behave like
  // transient ones (X + 15 s timer) but collapse to a compact pill
  // instead of dismissing — they only vanish when polling clears
  // activeCashout / activeBuyOrder.
  const persistentToasts: Toast[] = [];
  if (activeCashout) {
    const statusDetail =
      activeCashout.status === "awaiting_transak"
        ? "Finish the sale in the Transak tab, or cancel now to get your tokens refunded immediately.\n(Abandoned orders are also auto-cancelled within a few hours.)"
        : activeCashout.status === "crypto_sent"
        ? "Funds sent to Transak. Waiting for the payout to your bank."
        : `Status: ${activeCashout.status.replace(/_/g, " ")}`;
    persistentToasts.push({
      id: `cashout-${activeCashout.cashoutId}`,
      variant: "info",
      title: "Sale in progress",
      description: statusDetail,
      collapsible: true,
      // Only offer the instant-refund button while the cashout is still
      // in awaiting_transak. Once status flips to crypto_sent the operator
      // has already broadcast the transfer to Transak's deposit address,
      // and the ledger refund would double-pay — same gate the server-
      // side refund helper enforces.
      // Reopen tutorial is the safer follow-up for a confused user, so
      // it goes in the primary slot (renders first/left). Cancel sale
      // only appears while the cashout is still cancellable; both are
      // styled identically — see Toast.secondaryAction comment.
      action: {
        label: "Reopen tutorial",
        onClick: () => setReferenceTutorialOpen(true),
        tone: "secondary",
      },
      secondaryAction:
        activeCashout.status === "awaiting_transak"
          ? {
              label: "Cancel sale",
              onClick: () => setCancelConfirmOpen(true),
              loading: cancellingCashout,
            }
          : undefined,
    });
  }
  if (activeBuyOrder) {
    if (activeBuyOrder.kind === "trade") {
      const statusDetail =
        activeBuyOrder.status === "pending_payment"
          ? "Complete your payment in the Transak tab, or cancel this purchase.\n(Abandoned orders are also auto-cancelled within a few hours.)"
          : activeBuyOrder.status === "payment_received"
          ? "Payment confirmed by Transak. Your PLAT is on the way — finalising your balance now."
          : `Status: ${activeBuyOrder.status.replace(/_/g, " ")}`;
      persistentToasts.push({
        id: `buy-${activeBuyOrder.orderId}`,
        variant: "info",
        title: "PLAT purchase in progress",
        description: statusDetail,
        collapsible: true,
        // Only offer Cancel while the payment hasn't been taken yet. Once
        // Transak flips the order to payment_received the card is charged and
        // cancelBuyOrderAction would reject it anyway — same gate, server-side.
        secondaryAction:
          activeBuyOrder.status === "pending_payment"
            ? {
                label: "Cancel purchase",
                onClick: () => setCancelBuyConfirmOpen(true),
                loading: cancellingBuy,
              }
            : undefined,
      });
    } else {
      // kind === "stable" — standalone on-ramp top-up. Title and copy
      // intentionally use "purchase" (not "top-up") so PLAT and stable
      // variants read identically apart from the token name.
      const tt = activeBuyOrder.targetToken;
      const statusDetail =
        activeBuyOrder.status === "pending"
          ? `Complete your payment in the Transak tab, or cancel this purchase.\n(Abandoned orders are also auto-cancelled within a few hours.)`
          : activeBuyOrder.status === "processing"
          ? `Payment confirmed by Transak. Your ${tt} is on the way — finalising your balance now.`
          : activeBuyOrder.status === "completed"
          ? `Finalising your ${tt} balance…`
          : `Status: ${activeBuyOrder.status.replace(/_/g, " ")}`;
      persistentToasts.push({
        id: `buy-${activeBuyOrder.partnerOrderId}`,
        variant: "info",
        title: `${tt} purchase in progress`,
        description: statusDetail,
        collapsible: true,
        // Mirror the trade branch: Cancel is only safe while the on-ramp
        // order is still 'pending' (unpaid). cancelStableTopUpAction enforces
        // the same window server-side.
        secondaryAction:
          activeBuyOrder.status === "pending"
            ? {
                label: "Cancel purchase",
                onClick: () => setCancelBuyConfirmOpen(true),
                loading: cancellingBuy,
              }
            : undefined,
      });
    }
  }
  if (activeConvert) {
    persistentToasts.push({
      id: `convert-${activeConvert.fromToken}-${activeConvert.toToken}`,
      variant: "info",
      title: "Conversion in progress",
      description: `Converting ${formatFixed2(
        parseFloat(activeConvert.fromAmount)
      )} ${activeConvert.fromToken} → ${formatFixed2(
        parseFloat(activeConvert.toAmount)
      )} ${activeConvert.toToken}. This usually takes a few seconds.`,
      collapsible: true,
    });
  }
  const allToasts = [...transientToasts, ...persistentToasts];

  // First-render loading state. We deliberately do NOT early-return a
  // full-page skeleton here: the page chrome (title, mode tabs, form
  // labels, rate-card chrome, activity title + "See all") is all
  // static and can paint on frame one. Only the dynamic values inside
  // the right rail need to skeleton — the exchange-rate / balance
  // numbers and the activity rows. The forms themselves render with
  // zero balances until snapshot arrives, which is the natural empty
  // state of an unfilled form.
  const loading = !snapshot && !snapshotError;

  return (
    // Header, h1 and subtitle classes are kept in lock-step with the
    // Dashboard (components/Dashboard.tsx) and Staking
    // (components/Staking.tsx) pages so the title and subtitle don't
    // shift when the user navigates between Dashboard / Exchange /
    // Staking. The tabs-row + outer wrapper classes are shared with
    // Staking only (Dashboard has no mode selector). If you change one,
    // change the others.
    <div className="w-full max-w-full overflow-x-hidden space-y-5 sm:space-y-6 lg:space-y-8">
      <header className="text-center sm:text-left">
        <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-semibold text-[#4B5563]">
          PLAT Tokens — Buy, sell, or convert
        </h1>
        <p className="font-sans mt-1 text-sm text-[#4B5563]">
          Top up your balance, cash out to your bank, or swap between Tokens.
        </p>
      </header>
      <MobilePrimaryNav />

      <div className="grid w-full max-w-full min-w-0 grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ModeTabs mode={mode} onChange={setMode} />
        </div>
      </div>

      {/* On mobile, Buy stacks as form -> rate/balance rail -> compact activity;
          Sell/Convert keep the previous hero -> form -> compact activity order.
          On lg+ the form sits in the left column and the right rail sits beside it;
          the standard activity table moves below the main grid.

          The right-rail wrapper uses `display: contents` on mobile so
          its children (rail, activity) flow as direct items of the
          outer grid - that lets the form sit *between* them via the
          `order` utilities. On lg+, the wrapper becomes a flex-column
          while the activity feed follows the Dashboard /
          Staking page pattern as a full-width table section. */}
      <div className="grid gap-5 lg:grid-cols-5">
        {/* Right-rail wrapper: contents on mobile, flex col on lg+. */}
        <div className="contents lg:flex lg:flex-col lg:gap-5 lg:col-start-4 lg:col-span-2 lg:row-start-1 lg:self-stretch">
          {/* Rail comes after the form on mobile for all three modes. */}
          <div className="order-2 lg:order-none lg:h-full">
            <RateBalancesRail
              balances={snapshot?.balances ?? []}
              rates={snapshot?.rates ?? {}}
              context={
                mode === "buy"
                  ? buySidebar
                  : mode === "sell"
                  ? sellSidebar
                  : convertSidebar
              }
              loading={loading}
            />
          </div>
          {/* Compact recent activity — mobile order 3 (bottom). */}
          <div className="order-3 lg:hidden">
            <RecentActivityCard
              // Snapshot is fetched with the "exchange" filter, so its
              // `activity` field is already scoped to Exchange-only rows.
              // No client-side re-filter needed.
              rows={snapshot?.activity ?? []}
              error={snapshotError}
              onSeeAll={() => setActivityModalOpen(true)}
              total={activityTotal}
              loading={loading}
            />
          </div>
        </div>

        {/* Form column — mobile order 2 (between hero and activity),
            desktop col 1-3 row 1. */}
        <div className="order-1 min-w-0 max-w-full lg:order-none lg:col-start-1 lg:col-span-3 lg:row-start-1">
          {mode === "buy" && (
            <BuyForm
              balances={snapshot?.balances ?? []}
              loading={loading}
              onComplete={loadSnapshot}
              pushToast={pushToast}
              onSidebarChange={setBuySidebar}
            />
          )}
          {mode === "sell" && (
            <SellForm
              balances={snapshot?.balances ?? []}
              loading={loading}
              onComplete={loadSnapshot}
              pushToast={pushToast}
              onSidebarChange={setSellSidebar}
            />
          )}
          {mode === "swap" && (
            <ConvertForm
              balances={snapshot?.balances ?? []}
              loading={loading}
              onComplete={loadSnapshot}
              pushToast={pushToast}
              setActiveConvert={setActiveConvert}
              onSidebarChange={setConvertSidebar}
            />
          )}
        </div>
      </div>

      <div className="hidden lg:block">
        <StandardRecentActivitySection
          // Snapshot is fetched with the "exchange" filter, so its
          // `activity` field is already scoped to Exchange-only rows.
          rows={snapshot?.activity ?? []}
          error={snapshotError}
          onSeeAll={() => setActivityModalOpen(true)}
          total={activityTotal}
          loading={loading}
        />
      </div>

      {activityModalOpen && (() => {
        // Fall back to the snapshot's exchange-filtered feed while the
        // longer 50-row fetch is in flight, so the modal is never blank.
        const modalRows = fullActivity ?? snapshot?.activity ?? [];
        const modalLoading =
          modalRows.length === 0 && (fullActivityLoading || !snapshot);
        return (
          <TransactionHistoryModal
            rows={modalRows}
            loading={modalLoading}
            onClose={() => setActivityModalOpen(false)}
          />
        );
      })()}

      <ToastViewport toasts={allToasts} onDismiss={dismissToast} />

      {referenceTutorialOpen && (
        <WithdrawalTutorialModal
          mode="reference"
          submitting={false}
          onCancel={() => setReferenceTutorialOpen(false)}
        />
      )}

      {cancelConfirmOpen && activeCashout?.cashoutId && (
        <CancelSaleConfirmModal
          sourceToken={activeCashout.sourceToken}
          submitting={cancellingCashout}
          onCancel={() => {
            if (!cancellingCashout) setCancelConfirmOpen(false);
          }}
          onConfirm={handleCancelSale}
        />
      )}

      {cancelBuyConfirmOpen && activeBuyOrder && (
        <CancelBuyConfirmModal
          submitting={cancellingBuy}
          onCancel={() => {
            if (!cancellingBuy) setCancelBuyConfirmOpen(false);
          }}
          onConfirm={handleCancelBuyOrder}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Mode tabs
// ─────────────────────────────────────────────────────────────────────

function ModeTabs({
  mode,
  onChange,
}: {
  mode: ExchangeMode;
  onChange: (m: ExchangeMode) => void;
}) {
  // Buy / Sell are locked to PLAT, so the selectors name it explicitly.
  // The "PLAT" qualifier is a `suffix` rendered only at sm+ — on the
  // narrowest phones the three compact pills fall back to "Buy" / "Sell" /
  // "Convert" so the token name never clips mid-word inside the pill.
  const tabs: {
    id: ExchangeMode;
    label: string;
    suffix?: string;
    iconSrc: string;
    iconSize: string;
  }[] = [
    { id: "buy", label: "Buy", suffix: "PLAT", iconSrc: "/Nav_icons/Buy_Tokens.svg", iconSize: "80%" },
    { id: "sell", label: "Sell", suffix: "PLAT", iconSrc: "/Nav_icons/Sell_Tokens.svg", iconSize: "80%" },
    { id: "swap", label: "Convert", iconSrc: "/Nav_icons/Convert_Tokens.svg", iconSize: "95%" },
  ];
  const indicatorTransform =
    mode === "buy"
      ? "translateX(0)"
      : mode === "sell"
      ? "translateX(calc(100% + 6px))"
      : "translateX(calc(200% + 12px))";

  return (
    // Tab container + button classes mirror Staking's ModeTabs so the
    // selector renders at the same height, padding, and responsive text
    // sizes on both pages. If you tweak one, mirror the change in the
    // other (components/Staking.tsx -> ModeTabs).
    <div
      role="tablist"
      aria-label="Exchange mode"
      data-active={mode}
      className="relative grid w-full min-w-0 grid-cols-3 gap-[6px] overflow-hidden rounded-[10px] bg-white p-[6px] shadow-sm"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-[6px] left-[6px] rounded-[6px] bg-[#0EA5E9] shadow-sm transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
        style={{
          width: "calc((100% - 24px) / 3)",
          transform: indicatorTransform,
        }}
      />
      {tabs.map((t) => {
        const active = t.id === mode;

        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={
              active
                ? "relative z-10 flex min-h-[40px] min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] bg-transparent px-2 text-[13px] sm:gap-2 sm:px-4 sm:text-[16px] font-semibold text-white transition-colors duration-[160ms] ease-out"
                : "relative z-10 flex min-h-[40px] min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] bg-transparent px-2 text-[13px] sm:gap-2 sm:px-4 sm:text-[16px] font-semibold text-[#6B7280] transition-[color,font-weight] duration-[160ms] ease-out hover:font-bold hover:text-[#4B5563]"
            }
          >
           <span
              aria-hidden
              className="h-4 w-4 shrink-0 sm:h-[18px] sm:w-[18px]"
              style={{
                backgroundColor: "currentColor",
                WebkitMaskImage: `url(${t.iconSrc})`,
                maskImage: `url(${t.iconSrc})`,
                WebkitMaskSize: t.iconSize,
                maskSize: t.iconSize,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
            <span className="truncate ml-1">
              {t.label}
              {t.suffix && <span className="hidden sm:inline"> {t.suffix}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RateBalancesRail({
  balances,
  rates,
  context,
  loading = false,
}: {
  balances: { token_symbol: string; balance: string }[];
  rates: Record<string, number>;
  context: RateCardContext;
  loading?: boolean;
}) {
  return (
    <div className="flex h-full flex-col gap-5">
      <ExchangeRateCard context={context} />
      <BuyTokenBalancesCard
        balances={balances}
        rates={rates}
        loading={loading}
      />
    </div>
  );
}

function ExchangeRateCard({
  context,
}: {
  context: RateCardContext;
}) {
  // Convert (token→token) carries a quoteToken; Buy/Sell quote into fiat.
  const isTokenQuote = context.quoteToken != null;
  const rateLabel =
    context.rate != null && Number.isFinite(context.rate)
      ? isTokenQuote
        ? `${formatFixed2(context.rate)} ${context.quoteToken}`
        : `${formatFiat(context.rate, context.fiatCurrency, {
            maxFractionDigits: 2,
          })} ${context.fiatCurrency}`
      : "-";

  return (
    <section className="ex-card p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-[18px] font-semibold leading-6 text-[#4B5563]">
          Exchange rate
        </h2>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[11px] font-medium leading-4 text-[#9CA3AF]">
            Using the latest market rate
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#CFF2FF] px-2.5 py-1 text-[11px] font-medium leading-4 text-[#0B84BA]">
            <span className="h-2 w-2 rounded-full bg-[#0EA5E9]" />
            Live
          </span>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <RatePill
          iconSrc={tokenIconSrc(context.token)}
          label={`1.00 ${context.token}`}
          labelWidthClass="w-[132px]"
        />
        <span className="font-display text-[24px] font-semibold leading-none text-[#4B5563]">
          =
        </span>
        <RatePill
          iconSrc={
            isTokenQuote
              ? tokenIconSrc(context.quoteToken as TokenSymbol)
              : fiatIconSrc(context.fiatCurrency)
          }
          label={context.loadingRate ? null : rateLabel}
          labelWidthClass="w-[96px]"
        />
      </div>
    </section>
  );
}

function RatePill({
  iconSrc,
  label,
  labelWidthClass,
}: {
  iconSrc: string;
  label: string | null;
  labelWidthClass: string;
}) {
  return (
    <div className="flex w-full min-w-0 items-center justify-center gap-2.5 rounded-[8px] bg-[#F5F7FA] px-3 py-3">
      <img
        src={iconSrc}
        alt=""
        className="h-8 w-8 shrink-0 rounded-full object-contain"
      />
      <span
        className={`flex h-5 min-w-0 items-center justify-center ${labelWidthClass}`}
      >
        {label == null ? (
          <span className="h-5 w-full rounded bg-slate-200/80 animate-pulse" />
        ) : (
          <span className="min-w-0 truncate text-center font-sans text-[16px] font-medium text-[#4B5563]">
            {label}
          </span>
        )}
      </span>
    </div>
  );
}

function BuyTokenBalancesCard({
  balances,
  rates,
  loading = false,
}: {
  balances: { token_symbol: string; balance: string }[];
  rates: Record<string, number>;
  loading?: boolean;
}) {
  return (
    <section className="ex-card flex flex-1 flex-col overflow-hidden">
      <div className="px-5 pt-5 pb-3 sm:px-6 sm:pt-6">
        <h2 className="font-display text-[18px] font-semibold leading-6 text-[#4B5563]">
          Your Token Balances
        </h2>
      </div>

      <div className="flex flex-1 flex-col">
        {BUY_BALANCE_TOKENS.map((token, index) => {
          const balance = parseFloat(
            balances.find((b) => b.token_symbol === token)?.balance ?? "0"
          );
          return (
            <div
              key={token}
              className={`flex min-h-[58px] flex-1 items-center gap-3 px-5 py-3 sm:px-6 ${
                index === 0 ? "" : "border-t border-[#EEF0F3]"
              }`}
            >
              <img
                src={tokenIconSrc(token)}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full object-contain"
              />
              <span className="min-w-0 flex-1 truncate font-display text-[16px] font-medium text-[#111827]">
                {TOKEN_BALANCE_NAMES[token]}
              </span>
              <div className="shrink-0 text-right">
                {loading ? (
                  <div className="ml-auto h-4 w-16 rounded bg-slate-200/80 animate-pulse" />
                ) : (
                  <p className="flex items-baseline justify-end gap-1 whitespace-nowrap font-display leading-5 text-[#4B5563]">
                    {/* Role: rail value — the balance amount reads a step
                        above the rate pill so the user's holdings are easy
                        to scan down the column. */}
                    <span className="text-[18px] font-medium">
                      {formatBalance(balance)}
                    </span>
                    {/* Role: rail unit — demoted below the value. */}
                    <span className="text-[14px] font-regular text-[#6B7280]">
                      {token}
                    </span>
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Right rail — Recent activity
// ─────────────────────────────────────────────────────────────────────

function StandardRecentActivitySection({
  rows,
  error,
  onSeeAll,
  total,
  loading = false,
}: {
  rows: DashboardActivity[];
  error: string | null;
  onSeeAll: () => void;
  total: number | null;
  loading?: boolean;
}) {
  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-[24px] text-[#4B5563] font-semibold">
          Recent activity
        </h2>
        <div className="flex items-center gap-3">
          {!loading && total != null && total > 0 && (
            <span className="text-xs text-[var(--ex-text-muted)]">
              Showing {Math.min(rows.length, total)} of {total} items
            </span>
          )}
          <button
            type="button"
            onClick={onSeeAll}
            className="seeall-recentactivity text-xs font-medium px-4 py-1.5 border-1 border-transparent rounded-[4px] text-white bg-[#0EA5E9] transition-colors cursor-pointer"
          >
            See all
          </button>
        </div>
      </div>

      {loading ? (
        <ActivityTableSkeleton rows={4} withHeader />
      ) : error ? (
        <div className="ex-card p-6 text-sm text-[var(--ex-text-muted)]">
          Couldn&apos;t load recent activity.
        </div>
      ) : rows.length > 0 ? (
        <ActivityTable rows={rows} loading={false} />
      ) : (
        <div className="ex-card overflow-hidden">
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
      )}
    </section>
  );
}

function RecentActivityCard({
  rows,
  error,
  onSeeAll,
  total,
  loading = false,
}: {
  rows: DashboardActivity[];
  error: string | null;
  onSeeAll: () => void;
  total: number | null;
  /**
   * When true, renders pulsing skeleton rows instead of the real list /
   * empty state. The title + "See all" button stay visible so the user
   * always sees the section header from frame one.
   */
  loading?: boolean;
}) {
  // EMPTY STATE FUNCTION - recent activity -  const visible: DashboardActivity[] = [];

  const visible = rows.slice(0, 4);
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-[18px] sm:text-[24px] font-semibold text-[#4B5563]">Recent activity</h2>
        <div className="flex items-center gap-3">
          {!loading && total != null && total > 0 && (
            <span className="hidden sm:inline text-xs text-[var(--ex-text-muted)]">
              Showing {Math.min(visible.length, total)} of {total} items
            </span>
          )}
          <button
            type="button"
            onClick={onSeeAll}
            className="seeall-recentactivity text-xs font-medium px-4 py-1.5 border-1 border-transparent rounded-[4px] text-white bg-[#0EA5E9] transition-colors cursor-pointer"
          >
            See all
          </button>
        </div>
      </div>

      {loading ? (
        // Pulsing skeleton rows that mirror ActivityRow's layout. Same
        // visual the user already approved when this lived inside the
        // (now removed) page-wide ExchangeSkeleton.
        <ActivityTableSkeleton rows={4} />
      ) : error ? (
        <div className="ex-card p-4 text-sm text-[var(--ex-text-muted)]">
          Couldn&apos;t load recent activity.
        </div>
      ) : visible.length === 0 ? (
        <div className="ex-card flex min-h-[90px] items-center justify-center gap-3 sm:gap-5 px-4 sm:px-6 py-6 sm:py-7">
          <img
            src="/icons/no-recent-activity.svg"
            alt=""
            aria-hidden
            className="h-[54px] w-[54px] shrink-0 object-contain opacity-80"
          />
          <p className="font-sans text-[16px] sm:text-[24px] font-semibold leading-tight sm:leading-[32px] text-[rgba(17,24,39,0.4)]">
            No recent activity
          </p>
        </div>
      ) : (
      <div className="ex-card overflow-hidden">
        {visible.map((row) => (
          <ActivityRow key={row.id} row={row} />
        ))}
      </div>
    )}
    </div>
  );
}

function ActivityRow({ row }: { row: DashboardActivity }) {
  // Pre-format both representations of each side so the JSX dual-render
  // pattern stays terse. `paidCompact`/`receivedCompact` apply on
  // desktop (rail card is narrow), `paidFull`/`receivedFull` on mobile
  // (vertical card has wrap room and no hover tooltip).
  const paidFull = row.paidLabel
    ? formatActivityAmount(row.paidLabel, { compact: false })
    : null;
  const paidCompact = row.paidLabel
    ? formatActivityAmount(row.paidLabel, { compact: true })
    : null;
  const receivedFull = row.receivedLabel
    ? formatActivityAmount(row.receivedLabel, { compact: false })
    : null;
  const receivedCompact = row.receivedLabel
    ? formatActivityAmount(row.receivedLabel, { compact: true })
    : null;
  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-4 px-3 sm:px-5 min-h-[88px] sm:min-h-[96px] border-b border-[#E5E7EB] last:border-b-0">
      <KindBadge kind={row.kind} />

      <div className="min-w-0 flex-1 py-3">
        <p className="font-display text-[13px] sm:text-[14px] md:text-[16px] lg:text-[16px] font-semibold text-[#111827] truncate">
          {row.title}
        </p>
        <p className="-mt-0.5 flex min-w-0 items-center gap-1 whitespace-nowrap text-[12px] md:mt-0 md:text-[14px] lg:text-[14px] text-[#6B7280]">
          <StatusText status={row.status} />
          <span className="font-bold" aria-hidden>·</span>
          <span title={fullDateTitle(row.createdAt)}>
            {formatDate(row.createdAt)}
          </span>
        </p>
        {/* Failure reason subtitle removed at design's request; data
            still flows on `row.failureReason` if it needs to come back. */}
      </div>

      <div className="shrink-0 text-right">
        {receivedFull && (
          <p
            className={`font-sans text-[12px] md:text-[14px] lg:text-[14px] font-bold truncate ${amountToneClassExchange(row.amountTone)}`}
          >
            <span className="md:hidden" title={receivedFull}>
              {receivedFull}
            </span>
            <span
              className="hidden md:inline"
              title={receivedFull !== receivedCompact ? receivedFull : undefined}
            >
              {receivedCompact}
            </span>
          </p>
        )}
        {paidFull && (
          <p className="text-[12px] md:text-[14px] lg:text-[14px] text-[#6B7280] truncate">
            <span className="md:hidden" title={paidFull}>{paidFull}</span>
            <span
              className="hidden md:inline"
              title={paidFull !== paidCompact ? paidFull : undefined}
            >
              {paidCompact}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Mirror of `amountToneClass` in ActivityHistory.tsx, kept local to
 * Exchange so the rail-card layout doesn't have to import it. Same
 * three buckets: positive → green, negative → rose, neutral → slate.
 */
function amountToneClassExchange(
  tone: "positive" | "negative" | "neutral"
): string {
  if (tone === "positive") return "text-emerald-600";
  if (tone === "negative") return "text-rose-600";
  return "text-[#374151]";
}

//icons color action recent activity
function KindBadge({ kind }: { kind: DashboardActivityKind }) {
  const styles: Record<DashboardActivityKind, { bg: string; iconSrc: string }> = {
    buy: { bg: "bg-[#E7EDFF]", iconSrc: "/icons/activitybuy.svg" },
    sell: { bg: "bg-[#DCFAF8]", iconSrc: "/icons/activitysell.svg" },
    swap: { bg: "bg-[#FFF5D9]", iconSrc: "/icons/activityswap.svg" },
    cashout: { bg: "bg-[#DCFAF8]", iconSrc: "/icons/activitysell.svg" },
    refund: {  bg: "bg-[#F3E8FF]", iconSrc: "/icons/activityrefund.svg" },
    stake: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitydeposited.svg" },
    unstake: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitycollected.svg" },
    reward: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitycollected.svg" },
  };

  const s = styles[kind];

  return (
    <span className={`h-[32px] w-[32px] sm:h-[34px] sm:w-[34px] rounded-full flex items-center justify-center shrink-0 ${s.bg}`}>
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

function StatusText({
  status,
}: {
  status: "success" | "pending" | "failed" | "cancelled";
}) {
  const baseClass = "font-sans text-[11px] md:text-[14px] lg:text-[14px] font-medium";

  if (status === "success") {
    return (
      <span className={`${baseClass} text-[#61BB84]`}>
        Completed
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span className={`${baseClass} text-[#FFAA90]`}>
        Pending
      </span>
    );
  }

  if (status === "cancelled") {
    return (
      <span className={`${baseClass} text-slate-600`}>
        Cancelled
      </span>
    );
  }

  return (
    <span className={`${baseClass} text-rose-700`}>
      Failed
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// BUY  — fiat → PLAT via Transak on-ramp
//
// Always passes `skipBalance: true` to the server actions so the user's
// existing stablecoin balance does NOT subsidize the purchase — a card
// buy is a fresh top-up, the entire entered amount runs through Transak.
//
// Transak Lite-KYC bounds the charge to per-currency mins. Above the
// Lite-KYC max the widget prompts for a KYC upgrade — we surface that
// as an informational green chip instead of blocking submit. We surface
// both limits as live warnings (same UX pattern as the Sell tab's
// minimum-cashout warning) and disable the Buy button until the amount
// is in range, so users never wait for a server error to find out.
// ─────────────────────────────────────────────────────────────────────

// Bounds live in `app/lib/transak-limits.ts` — single source of truth
// shared with the server gate. See that file for the rationale behind
// the per-currency mins vs. USD-equivalent max.

interface StableTopUpQuoteShape {
  fiatCurrency: FiatCurrency;
  fiatAmount: number;
  grossFiatAmount: number;
  targetToken: TokenSymbol;
  transakFee: number;
  feePercent: number;
  netTusdAmount: number;
  receiveAmount: number;
  usdxToTargetRate: number;
  fiatPerTarget: number;
}

function BuyForm({
  balances,
  loading = false,
  onComplete,
  pushToast,
  onSidebarChange,
}: {
  balances: { token_symbol: string; balance: string }[];
  /**
   * True while the parent snapshot fetch is in flight. Swaps the live
   * balance number in the "Balance:" side text for a skeleton pulse so
   * users don't see "0.00 PLAT" before the real balance lands.
   */
  loading?: boolean;
  onComplete: () => void | Promise<void>;
  pushToast: (t: Omit<Toast, "id">) => void;
  onSidebarChange?: (context: RateCardContext) => void;
}) {
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>("USD");
  // Buy is locked to PLAT — it always routes through the AMM-bound buy
  // flow (createBuyOrderAction). The stable-target on-ramp path below
  // (createStableTopUpAction, gated on `isStableTarget`) is retained but
  // unreachable from the UI; re-introducing a TokenDropdown here in place of
  // the fixed label lights the stable path back up with no other changes.
  const [receiveToken] = useState<TokenSymbol>("PLAT");
  const isStableTarget = receiveToken !== "PLAT";
  // Current holding of the token being bought — shown above the buy-token
  // dropdown so users see "I have X already, I'm adding Y more". Display-
  // only (no MAX: a purchase doesn't spend the token you're buying).
  const receiveBalance = parseFloat(
    balances.find((b) => b.token_symbol === receiveToken)?.balance ?? "0"
  );

  const [payAmount, setPayAmount] = useState("");
  // Receive-side input is editable too — users frequently know how many
  // tokens they want, not how many dollars to spend. `lastEditedField`
  // tracks which side drove the latest quote so we know whether to
  // forward-quote (pay → receive) or inversely derive pay from a
  // target token amount.
  const [receiveAmount, setReceiveAmount] = useState("");
  const [lastEditedField, setLastEditedField] = useState<"pay" | "receive">(
    "pay"
  );
  const [quote, setQuote] = useState<BuyQuote | null>(null);
  const [stableQuote, setStableQuote] = useState<StableTopUpQuoteShape | null>(
    null
  );
  // Reference-amount rate used as a fallback before the user types.
  // `displayRateValue` stays numeric so the receive→pay inversion and
  // Buy-only exchange-rate card can use it when no live quote exists yet.
  // Loading flag starts true so the right rail can paint its skeleton
  // on first frame — identical pattern to the Sell tab.
  const [displayRateValue, setDisplayRateValue] = useState<number | null>(null);
  const [loadingDisplayRate, setLoadingDisplayRate] = useState(true);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Both bounds are per-currency hardcoded values from Transak's actual
  // widget (mins are hard rejections; maxes are Lite-KYC tier ceilings
  // that prompt for a KYC upgrade rather than blocking).
  const minInFiat = TRANSAK_MIN_PER_CURRENCY[fiatCurrency];
  const maxInFiat = TRANSAK_LITE_MAX_PER_CURRENCY[fiatCurrency];

  // Pay-driven quote (forward): user typed in "You pay", we forward-quote
  // and write the result into "You receive". Bails when the receive side
  // is the active editor so we never overwrite their typed target.
  useEffect(() => {
    if (lastEditedField !== "pay") return;
    // Drop stale quote data immediately while the debounced quote catches
    // up, so the helper/CTA never evaluate a previous purchase amount.
    setQuote(null);
    setStableQuote(null);

    let cancelled = false;
    const timer = setTimeout(async () => {
      const v = parseFloat(payAmount);
      if (!Number.isFinite(v) || v <= 0) {
        setQuote(null);
        setStableQuote(null);
        setReceiveAmount("");
        setLoadingQuote(false);
        return;
      }
      setLoadingQuote(true);
      if (isStableTarget) {
        const res = await getStableTopUpQuote(
          fiatCurrency,
          payAmount,
          receiveToken
        );
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          const data = res.data as StableTopUpQuoteShape;
          setStableQuote(data);
          setQuote(null);
          setReceiveAmount(formatFixed2(Math.max(0, data.receiveAmount)));
        } else {
          setStableQuote(null);
        }
      } else {
        const res = await getBuyQuote(fiatCurrency, payAmount, {
          skipBalance: true,
        });
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          const data = res.data as BuyQuote;
          setQuote(data);
          setStableQuote(null);
          setReceiveAmount(formatFixed2(parseFloat(data.tglobalAmount)));
        } else {
          // Quote failures during typing stay silent — the CTA's
          // disabled-on-no-quote state already blocks submission.
          setQuote(null);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [payAmount, lastEditedField, fiatCurrency, receiveToken, isStableTarget]);

  // Receive-driven quote (inverse): user typed in "You receive", we
  // estimate the fiat from the current rate, forward-quote with that,
  // and write the estimated fiat into "You pay". The user's typed
  // receive value stays sticky — for PLAT the residual AMM slippage
  // is disclosed via the price-impact summary row.
  useEffect(() => {
    if (lastEditedField !== "receive") return;
    // Invalidate the prior quote synchronously so the chip and summary
    // rows can't gate on stale numbers while the debounced refetch is
    // in flight. Same defensive pattern as the Sell box — even though
    // Buy submission re-quotes server-side from the user's typed
    // amount, this prevents a misleading "Ready" chip + stale fee row
    // when the user edits the receive amount.
    setQuote(null);
    setStableQuote(null);

    let cancelled = false;
    const timer = setTimeout(async () => {
      const targetTokens = parseFloat(receiveAmount);
      if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
        setQuote(null);
        setStableQuote(null);
        setPayAmount("");
        setLoadingQuote(false);
        return;
      }
      if (displayRateValue == null || displayRateValue <= 0) {
        // Rate not loaded yet — wait for displayRateValue to populate;
        // this effect will re-fire once it does.
        return;
      }
      // Both rates are now fee-exclusive (the stable rate is the underlying
      // peg/FX, the AMM price is pre-fee), so gross up by ~5% so the forward
      // quote's fee-inclusive total lands near the user's target. For PLAT
      // residual AMM slippage still shows up in the price-impact row.
      const feeBuffer = 1 / 0.95;
      const fiatForQuote = (
        targetTokens *
        displayRateValue *
        feeBuffer
      ).toFixed(2);

      // Reflect the receive-driven estimate in payAmount immediately so
      // the status chip's min/max checks are correct even when the quote
      // API rejects the amount (sub-Transak-quote-floor). Without this,
      // payAmount stayed empty on rejection → chip read "Please enter an
      // amount", and after a currency switch payAmount could linger as a
      // value from the previous currency → chip briefly flipped to
      // "Ready" against the new currency's band (e.g. R$11 from a BRL
      // quote falling inside USD's $5–$50 range).
      setPayAmount(fiatForQuote);

      setLoadingQuote(true);
      if (isStableTarget) {
        const res = await getStableTopUpQuote(
          fiatCurrency,
          fiatForQuote,
          receiveToken
        );
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          setStableQuote(res.data as StableTopUpQuoteShape);
          setQuote(null);
        } else {
          setStableQuote(null);
        }
      } else {
        const res = await getBuyQuote(fiatCurrency, fiatForQuote, {
          skipBalance: true,
        });
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          setQuote(res.data as BuyQuote);
          setStableQuote(null);
        } else {
          setQuote(null);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    receiveAmount,
    lastEditedField,
    fiatCurrency,
    receiveToken,
    isStableTarget,
    displayRateValue,
  ]);

  // Reference-amount rate fetch — populates the "You pay" side text
  // whenever there's no live quote yet. Mirrors the Sell tab's
  // resolved/retry/give-up pattern so the skeleton can't get stuck on
  // a stalled cold-start.
  useEffect(() => {
    let cancelled = false;
    let resolved = false;
    setLoadingDisplayRate(true);
    // Clear the numeric rate immediately so the receive→pay inversion
    // effect doesn't invert a stale token's rate during a token swap.
    // It'll re-fire once `apply()` sets the fresh value below.
    setDisplayRateValue(null);

    const apply = (ratePerToken: number | null) => {
      if (cancelled || resolved) return;
      resolved = true;
      if (ratePerToken != null && Number.isFinite(ratePerToken)) {
        setDisplayRateValue(ratePerToken);
      } else {
        setDisplayRateValue(null);
      }
      setLoadingDisplayRate(false);
    };

    // Reference of 100 fiat units — comfortably above every per-currency
    // Transak minimum so the quote endpoints always return usable data.
    const REF_FIAT = "100";

    const fetchOnce = async () => {
      try {
        if (isStableTarget) {
          const res = await getStableTopUpQuote(
            fiatCurrency,
            REF_FIAT,
            receiveToken
          );
          apply(
            res.success
              ? (res.data as StableTopUpQuoteShape).fiatPerTarget
              : null
          );
        } else {
          const res = await getBuyQuote(fiatCurrency, REF_FIAT, {
            skipBalance: true,
          });
          if (res.success) {
            const q = res.data as BuyQuote;
            // Use the AMM spot price (not the effective post-slippage price)
            // for the placeholder rate — REF_FIAT is $100, which produces a
            // big enough trade to introduce visible slippage on a small pool
            // and would otherwise show $0.75/PLAT here while the
            // Dashboard / Sell / Convert surfaces all show $0.74 spot.
            // Once the user types, the live rate switches to
            // ammEffectivePrice for their actual amount.
            const fiatPerToken =
              parseFloat(q.ammSpotPrice) / (q.fiatToTusdRate || 1);
            apply(fiatPerToken);
          } else {
            apply(null);
          }
        }
      } catch {
        apply(null);
      }
    };

    fetchOnce();

    const retryId = setTimeout(() => {
      if (!resolved && !cancelled) fetchOnce();
    }, 4000);

    const giveUpId = setTimeout(() => {
      if (resolved || cancelled) return;
      setLoadingDisplayRate(false);
    }, 10000);

    return () => {
      cancelled = true;
      clearTimeout(retryId);
      clearTimeout(giveUpId);
    };
  }, [receiveToken, fiatCurrency, isStableTarget]);

  // Live min/max derivation. `belowMin` blocks submit (Transak rejects
  // below their widget floor — no KYC path around it). `aboveMax` is
  // INFORMATIONAL only — the widget lets users upgrade KYC for higher
  // amounts, so the button stays enabled and a green heads-up chip
  // tells them what to expect on the Transak checkout.
  const payNum = parseFloat(payAmount);
  const receiveNum = parseFloat(receiveAmount);
  const hasReceiveInput = Number.isFinite(receiveNum) && receiveNum > 0;
  const hasInput = Number.isFinite(payNum) && payNum > 0;
  const belowMin = hasInput && payNum < minInFiat;
  const aboveMax = hasInput && payNum > maxInFiat;
  // The receive field is the user's editable control. Translate the fiat
  // minimum into that token amount using the same estimate as the
  // receive-driven quote, then round up so the suggestion safely clears it.
  const minimumReceiveAmount =
    displayRateValue != null && displayRateValue > 0
      ? Math.ceil(
          (minInFiat /
            (displayRateValue * (1 / 0.95))) *
            100
        ) / 100
      : null;

  // Unified "have a usable quote" flag for the CTA disabled-state logic.
  const haveQuote = isStableTarget ? !!stableQuote : !!quote;

  // The editable pay field uses `payAmount`; this stays for the modal total.
  const grossPayAmount: number | null = isStableTarget
    ? stableQuote
      ? // fiatAmount is already fee-inclusive (= gross + fee), so it IS the total.
        stableQuote.fiatAmount
      : null
    : quote && quote.transakFees
    ? parseFloat(quote.fiatAmount) + quote.transakFees.totalFee
    : null;

  const reviewExchangeRate = isStableTarget
    ? stableQuote?.fiatPerTarget ?? null
    : quote
    ? parseFloat(quote.ammEffectivePrice) / (quote.fiatToTusdRate || 1)
    : null;
  const reviewPurchaseAmount = isStableTarget
    ? stableQuote?.grossFiatAmount ?? null
    : quote
    ? parseFloat(quote.fiatAmount)
    : null;
  const reviewProcessingFee = isStableTarget
    ? stableQuote?.transakFee ?? null
    : quote?.transakFees?.totalFee ?? null;
  const reviewPriceEffectBps = !isStableTarget && quote
    ? quote.priceImpactBps ?? 0
    : null;
  const reviewPriceEffectValue =
    reviewPriceEffectBps != null && reviewPriceEffectBps >= 500 ? (
      <PriceImpactValue
        bps={reviewPriceEffectBps}
        direction="up"
      />
    ) : null;
  const reviewDisabled = !haveQuote || submitting || belowMin;

  const liveBuyRate = isStableTarget
    ? stableQuote?.fiatPerTarget ?? null
    : quote
    ? parseFloat(quote.ammEffectivePrice) / (quote.fiatToTusdRate || 1)
    : null;
  const sidebarRate =
    liveBuyRate != null && Number.isFinite(liveBuyRate)
      ? liveBuyRate
      : displayRateValue != null && Number.isFinite(displayRateValue)
      ? displayRateValue
      : null;
  const sidebarRateLoading =
    (loadingQuote && hasInput) || (loadingDisplayRate && sidebarRate == null);

  useEffect(() => {
    onSidebarChange?.({
      token: receiveToken,
      fiatCurrency,
      rate: sidebarRate,
      loadingRate: sidebarRateLoading,
    });
  }, [
    onSidebarChange,
    receiveToken,
    fiatCurrency,
    sidebarRate,
    sidebarRateLoading,
  ]);

  const openReviewPurchase = () => {
    if (reviewDisabled) return;
    setReviewOpen(true);
  };

  const handleBuy = async () => {
    setSubmitting(true);
    if (isStableTarget) {
      // Stable top-up: skip the AMM, credit USDX via Transak, and (for
      // non-USD targets) chain a Chainlink ledger swap to the chosen stable.
      const res = await createStableTopUpAction(
        fiatCurrency,
        payAmount,
        receiveToken
      );
      setSubmitting(false);
      if (!res.success) {
        pushToast({
          variant: "error",
          title: "Top-up failed",
          description: res.error,
        });
        return;
      }
      setReviewOpen(false);
      window.open(res.data.widgetUrl, "_blank", "noopener,noreferrer");
      pushToast({
        variant: "info",
        title: "Transak opened",
        description: `Complete the payment in the new tab — your ${receiveToken} will arrive automatically.`,
      });
      setPayAmount("");
      setReceiveAmount("");
      setLastEditedField("pay");
      setStableQuote(null);
      void onComplete();
      return;
    }

    // PLAT path.
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `buy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Charge the fee-inclusive total (what the modal shows as "You'll pay"),
    // NOT the bare token cost. Transak treats the amount it receives as
    // fee-inclusive — it skims its fee out of that number — so sending the
    // token cost alone would deliver too little USDC and short the purchase.
    // Sending the gross makes Transak deliver the token cost worth of USDC,
    // and createBuyOrder sizes the PLAT output from that net amount, so
    // the user receives what they asked for. Falls back to payAmount if the
    // quote (and thus the gross) isn't available yet.
    const chargeFiat =
      grossPayAmount != null && Number.isFinite(grossPayAmount)
        ? grossPayAmount.toFixed(2)
        : payAmount;
    const res = await createBuyOrderAction(
      fiatCurrency,
      chargeFiat,
      idempotencyKey,
      { skipBalance: true }
    );
    setSubmitting(false);
    if (!res.success) {
      pushToast({
        variant: "error",
        title: "Buy failed",
        description: res.error,
      });
      return;
    }
    setReviewOpen(false);
    if (res.data.pendingPayment) {
      // Open Transak in a new tab. No "Transak opened" toast here — the
      // in-flight purchase toast already covers the in-progress state, and
      // by this point the Transak tab has focus so a toast in the
      // background tab would just go unread (mirrors the Sell flow).
      window.open(res.data.widgetUrl, "_blank", "noopener,noreferrer");
    } else {
      pushToast({
        variant: "success",
        title: "Order placed",
        description: `You received ${formatTokenAmount(
          parseFloat(res.data.order.tglobal_amount)
        )} PLAT.`,
      });
    }
    setPayAmount("");
    setReceiveAmount("");
    setLastEditedField("pay");
    setQuote(null);
    void onComplete();
  };

  return (
    <FormCard>
      <FormTitle
        title="Buy PLAT"
        subtitle="Buy PLAT using a credit card, Apple Pay, Google Pay, or bank transfer."
      />

      <div className="relative mt-9 space-y-3">
        {/* Buy-only mockup layout: question, amount, and dropdown all live
            inside each field. The editable amount anchors left; the token /
            currency dropdown anchors right (next to the balances rail). */}
        <FieldShell
          label="You Buy"
          bodyCentered
          sideText={
            <span className="font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
              Current balance:{" "}
              {loading ? (
                <span
                  aria-hidden
                  className="inline-block h-[12px] w-[80px] rounded bg-[#E5E7EB] animate-pulse align-middle"
                />
              ) : (
                <span className="font-semibold text-[#6B7280]">
                  {formatBalance(receiveBalance)} {receiveToken}
                </span>
              )}
            </span>
          }
        >
          <NumberInput
            value={receiveAmount}
            onChange={(v) => {
              setReceiveAmount(v);
              setLastEditedField("receive");
            }}
            placeholder={loadingQuote ? "..." : "0.00"}
            maxDecimals={2}
            suffix={receiveToken}
            showSuffixWhenEmpty
            align="left"
          />
          <FixedTokenLabel value={receiveToken} />
        </FieldShell>

        <DownConnector />

        {/* Same Q&A pattern as the receive row. Payment value is the
            purchase amount before processing fees.
            The user can drive either field; this
            field updates payAmount for submit while the opposite field
            reacts through the quote effect. Rate floats to the far right
            mirroring the balance placement on the receive side. */}
        <FieldShell
          variant="input"
          label="You Pay"
          bodyCentered
        >
          <NumberInput
            value={payAmount}
            placeholder={loadingQuote ? "..." : "0.00"}
            onChange={(v) => {
              setPayAmount(v);
              setLastEditedField("pay");
              setQuote(null);
              setStableQuote(null);
              setReceiveAmount("");
              if (v !== "") {
                setLoadingQuote(true);
              } else {
                setLoadingQuote(false);
              }
            }}
            maxDecimals={2}
            prefix={FIAT_SYMBOLS[fiatCurrency]}
            suffix={fiatCurrency}
            showSuffixWhenEmpty
            align="left"
          />
          <CurrencyDropdown
            value={fiatCurrency}
            options={FIAT_OPTIONS}
            header="Pay with Card / Bank"
            bare
            style={{ transform: "translateY(-8px)" }}
            onChange={(v) => {
              setFiatCurrency(v as FiatCurrency);
              if (hasReceiveInput) {
                setLoadingQuote(true);
              }
              // Drop the stale quote — it was priced in the previous
              // currency, so both the receive amount and the rate
              // would be wrong until the debounced refetch lands.
              setQuote(null);
              setStableQuote(null);
              // In receive-driven mode payAmount is computed from the
              // receive amount × rate of the OLD currency. Leaving it
              // lets the chip briefly evaluate min/max against the
              // wrong amount before the receive effect re-fires.
              if (lastEditedField === "receive") {
                setPayAmount("");
              }
            }}
          />
        </FieldShell>
      </div>

      <div className="mt-6">
        <StatusChip
          className="mb-6"
          {...((): ChipState => {
            if (loadingQuote && hasReceiveInput) {
              return {
                variant: "info",
                message: "Calculating quote\u2026",
              };
            }
            if (!hasInput) {
              return {
                variant: "info",
                message: "Please enter an amount to buy.",
              };
            }
            if (belowMin) {
              return {
                variant: "warning",
                message:
                  minimumReceiveAmount != null
                    ? `Minimum ${fiatCurrency} purchase is ${formatFiat(
                        minInFiat,
                        fiatCurrency
                      )} (${formatFixed2(
                        minimumReceiveAmount
                      )} ${receiveToken})`
                    : `Minimum ${fiatCurrency} purchase amount is not available yet.`,
              };
            }
            // Quote hasn't arrived yet (350 ms debounce + network). Avoid
            // flashing the green "Ready" chip — the submit button stays
            // disabled by `haveQuote`, but the chip would otherwise fall
            // straight through to a "ready" branch. The min warning above
            // doesn't need a quote (the per-currency floor is a constant),
            // but the aboveMax / ready branches do.
            if (!haveQuote) {
              return {
                variant: "info",
                message: "Calculating quote…",
              };
            }
            if (aboveMax) {
              return {
                variant: "ready",
                message:
                  "Ready to proceed — continue to checkout (a quick ID check may be required).",
              };
            }
            if (isStableTarget) {
              return {
                variant: "ready",
                message:
                  "Ready to proceed — continue to checkout (a quick ID check may be required).",
              };
            }
            return {
              variant: "ready",
              message:
                "Ready to proceed — continue to checkout (a quick ID check may be required).",
            };
          })()}
        />

        <div>
          <PrimaryButton
            label="Review Purchase"
            loading={submitting}
            disabled={reviewDisabled}
            onClick={openReviewPurchase}
          />
        </div>

        <div className="!mt-4 -mb-1 sm:-mb-2 lg:-mb-3">
          <Fineprint
            text={
              isStableTarget
                ? `Payments are processed by our partner Transak. Your ${receiveToken} arrives in your balance once the payment is confirmed.`
                : "Payments are processed by our partner Transak. Your PLAT arrives in your balance once the payment is confirmed."
            }
          />
        </div>
      </div>

      {reviewOpen && (
        <BuyReviewModal
          token={receiveToken}
          tokenAmountLabel={"You are buying"}
          tokenAmount={`${formatFixed2(Math.max(0, receiveNum || 0))} ${receiveToken}`}
          exchangeRate={
            reviewExchangeRate != null && Number.isFinite(reviewExchangeRate)
              ? `1 ${receiveToken} = ${formatFiat(reviewExchangeRate, fiatCurrency, {
                  maxFractionDigits: 2,
                })}`
              : "-"
          }
          purchaseAmount={
            reviewPurchaseAmount != null && Number.isFinite(reviewPurchaseAmount)
              ? formatFiat(reviewPurchaseAmount, fiatCurrency)
              : "-"
          }
          processingFee={
            reviewProcessingFee != null && Number.isFinite(reviewProcessingFee)
              ? formatFiat(reviewProcessingFee, fiatCurrency)
              : "-"
          }
          paymentTotal={
            grossPayAmount != null && Number.isFinite(grossPayAmount)
              ? formatFiat(grossPayAmount, fiatCurrency)
              : "-"
          }
          priceEffect={reviewPriceEffectValue}
          loading={submitting}
          onClose={() => setReviewOpen(false)}
          onConfirm={handleBuy}
        />
      )}
    </FormCard>
  );
}

function BuyReviewModal({
  token,
  tokenAmountLabel,
  tokenAmount,
  exchangeRate,
  purchaseAmount,
  processingFee,
  paymentTotal,
  priceEffect,
  loading,
  onClose,
  onConfirm,
}: {
  token: TokenSymbol;
  tokenAmountLabel: string;
  tokenAmount: React.ReactNode;
  exchangeRate: React.ReactNode;
  purchaseAmount: React.ReactNode;
  processingFee: React.ReactNode;
  paymentTotal: React.ReactNode;
  priceEffect: React.ReactNode | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the order is being placed the modal is non-dismissable —
      // closing here would just race the Transak tab that's about to open.
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, loading]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/40 px-4 py-6 backdrop-blur-sm"
      onMouseDown={loading ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="buy-review-title"
        className="w-full max-w-[560px] rounded-xl border border-[var(--ex-border)] bg-white p-6 shadow-xl sm:p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3
            id="buy-review-title"
            className="flex items-center gap-2 font-display text-[20px] font-medium leading-[30px] text-[#111827]"
          >
            <img
              src={tokenIconSrc(token)}
              alt=""
              aria-hidden
              className="h-7 w-7 shrink-0 rounded-full"
            />
            <span>{token} Purchase Details</span>
          </h3>
          <ModalCloseButton
            onClick={onClose}
            disabled={loading}
            label="Close"
            size="lg"
            className="-mr-1"
          />
        </div>

        <div className="space-y-1 rounded-[10px] bg-[#F8FAFC] px-5 py-4">
          <ReviewModalRow label={tokenAmountLabel} value={tokenAmount} emphasize />
          <ReviewModalRow label="Exchange rate" value={exchangeRate} />
          <ReviewModalRow label="Token cost" value={purchaseAmount} />
          <ReviewModalRow
            label="Processing fee (est.)"
            value={processingFee}
            tooltip={BUY_PROCESSING_FEE_TOOLTIP}
          />
          {priceEffect && (
            <ReviewModalRow
              label="Est. price effect on PLAT"
              value={priceEffect}
              tooltip={BUY_PRICE_EFFECT_TOOLTIP}
            />
          )}
          <ReviewModalRow label={"You\u2019ll pay"} value={paymentTotal} total />
        </div>

        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={
            loading
              ? "mt-6 h-[56px] w-full cursor-not-allowed rounded-[6px] bg-[#D8DEE7] text-[17px] font-semibold text-[#738094] transition-colors"
              : "mt-6 h-[56px] w-full rounded-[6px] bg-[#0EA5E9] text-[17px] font-semibold text-white shadow-sm transition-colors hover:bg-[#3EB7ED] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0EA5E9] focus-visible:ring-offset-2"
          }
        >
          {loading ? "Working..." : "Continue to Checkout"}
        </button>

        <div className="mt-4">
          <Fineprint text="Next, Transak will guide you through payment. A quick ID check may be required." />
        </div>
      </div>
    </div>
  );
}

/**
 * Sale-review modal — the Sell-flow analogue of BuyReviewModal. Opened by
 * the "Review Sale" CTA. Its primary button is "Continue" (NOT a checkout
 * action): confirming here closes this modal and opens the existing
 * WithdrawalTutorialModal, which is what actually opens the Transak tab on
 * its final step. Keeping Transak out of this modal preserves the
 * popup-blocker contract documented on WithdrawalTutorialModal — the
 * synchronous window.open must stay attached to the tutorial's button.
 */
function SellReviewModal({
  token,
  tokenAmount,
  exchangeRate,
  grossAmount,
  cashOutFee,
  netReceive,
  priceEffect,
  loading,
  onClose,
  onConfirm,
}: {
  token: TokenSymbol;
  tokenAmount: React.ReactNode;
  exchangeRate: React.ReactNode;
  grossAmount: React.ReactNode;
  cashOutFee: React.ReactNode;
  netReceive: React.ReactNode;
  priceEffect: React.ReactNode | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/40 px-4 py-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sell-review-title"
        className="w-full max-w-[560px] rounded-xl border border-[var(--ex-border)] bg-white p-6 shadow-xl sm:p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3
            id="sell-review-title"
            className="flex items-center gap-2 font-display text-[20px] font-medium leading-[30px] text-[#111827]"
          >
            <img
              src={tokenIconSrc(token)}
              alt=""
              aria-hidden
              className="h-7 w-7 shrink-0 rounded-full"
            />
            <span>{token} Sale Details</span>
          </h3>
          <ModalCloseButton
            onClick={onClose}
            label="Close"
            size="lg"
            className="-mr-1"
          />
        </div>

        <div className="space-y-1 rounded-[10px] bg-[#F8FAFC] px-5 py-4">
          <ReviewModalRow label={"You\u2019ll sell"} value={tokenAmount} emphasize />
          <ReviewModalRow label="Exchange rate" value={exchangeRate} />
          <ReviewModalRow label="Value before fee" value={grossAmount} />
          <ReviewModalRow
            label="Cash-out fee (est.)"
            value={cashOutFee}
            tooltip="This fee helps process your cash-out and is charged by Transak, not Exchange."
          />
          {priceEffect && (
            <ReviewModalRow
              label="Est. price effect on PLAT"
              value={priceEffect}
              tooltip="Larger sales can affect the PLAT price. This estimate shows the expected impact before you continue."
            />
          )}
          <ReviewModalRow label={"You\u2019ll receive"} value={netReceive} total />
        </div>

        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={
            loading
              ? "mt-6 h-[56px] w-full cursor-not-allowed rounded-[6px] bg-[#D8DEE7] text-[16px] font-semibold text-[#738094] transition-colors"
              : "mt-6 h-[56px] w-full rounded-[6px] bg-[#0EA5E9] text-[16px] font-semibold text-white shadow-sm transition-colors hover:bg-[#3EB7ED] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0EA5E9] focus-visible:ring-offset-2"
          }
        >
          {loading ? "Working..." : "Continue to Cash-Out"}
        </button>

        <div className="mt-4">
          <Fineprint text="Next, we'll walk you through the quick cash-out steps before opening Transak." />
        </div>
      </div>
    </div>
  );
}

/**
 * Conversion-review modal — the Convert-flow analogue of BuyReviewModal /
 * SellReviewModal. Opened by the "Review Conversion" CTA. Unlike Buy/Sell
 * there's no Transak hand-off: confirming here runs the conversion in-app
 * (onConfirm === handleConvert), so the CTA reads "Convert Now" and the
 * modal stays mounted (showing "Working...") until the action resolves.
 */
function ConvertReviewModal({
  fromToken,
  toToken,
  convertAmount,
  exchangeRate,
  priceEffect,
  receiveAmount,
  loading,
  onClose,
  onConfirm,
}: {
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  convertAmount: React.ReactNode;
  exchangeRate: React.ReactNode;
  priceEffect: React.ReactNode | null;
  receiveAmount: React.ReactNode;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Non-dismissable while the conversion is executing so a stray Escape
      // can't tear down the modal mid-flight.
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, loading]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/40 px-4 py-6 backdrop-blur-sm"
      onMouseDown={loading ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-review-title"
        className="w-full max-w-[560px] rounded-xl border border-[var(--ex-border)] bg-white p-6 shadow-xl sm:p-7"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3
            id="convert-review-title"
            className="flex items-center gap-2 font-display text-[20px] font-medium leading-[30px] text-[#111827]"
          >
            <img
              src={tokenIconSrc(fromToken)}
              alt=""
              aria-hidden
              className="h-7 w-7 shrink-0 rounded-full"
            />
            <span>
              Convert {fromToken} &rarr; {toToken}
            </span>
          </h3>
          <ModalCloseButton
            onClick={onClose}
            disabled={loading}
            label="Close"
            size="lg"
            className="-mr-1"
          />
        </div>

        <div className="space-y-1 rounded-[10px] bg-[#F8FAFC] px-5 py-4">
          <ReviewModalRow label={"You are converting"} value={convertAmount} emphasize />
          <ReviewModalRow label="Conversion rate" value={exchangeRate} />
          {priceEffect && (
            <ReviewModalRow
              label="Est. price effect on PLAT"
              value={priceEffect}
              tooltip="Larger conversions can affect the PLAT price. This estimate shows the expected impact before you continue."
            />
          )}
          <ReviewModalRow label={"You’ll receive"} value={receiveAmount} total />
        </div>

        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={
            loading
              ? "mt-6 h-[56px] w-full cursor-not-allowed rounded-[6px] bg-[#D8DEE7] text-[17px] font-semibold text-[#738094] transition-colors"
              : "mt-6 h-[56px] w-full rounded-[6px] bg-[#0EA5E9] text-[17px] font-semibold text-white shadow-sm transition-colors hover:bg-[#3EB7ED] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0EA5E9] focus-visible:ring-offset-2"
          }
        >
          {loading ? "Working..." : "Convert Now"}
        </button>

        <div className="mt-4">
          <Fineprint text="Conversions happen instantly in-app at the current market rate." />
        </div>
      </div>
    </div>
  );
}

function ReviewModalRow({
  label,
  value,
  tooltip,
  emphasize = false,
  total = false,
}: {
  label: string;
  value: React.ReactNode;
  tooltip?: string;
  emphasize?: boolean;
  /**
   * Marks the final outcome row (Buy "You'll pay", Sell "You'll receive").
   * Adds a soft divider above the row and a slightly stronger label/value
   * treatment so the bottom line is the easiest thing to scan. Takes
   * precedence over `emphasize`.
   */
  total?: boolean;
}) {
  return (
    <div
      className={
        total
          ? // Center the row between the divider and the gray box's bottom
            // edge: the box adds 16px (py-4) below this row, so a 20px top
            // pad balances the 4px bottom pad + that 16px.
            "flex items-start justify-between gap-4 mt-1 border-t border-[var(--ex-border)] pt-5 pb-1"
          : "flex items-start justify-between gap-4 py-2"
      }
    >
      <span
        className={
          total
            ? "inline-flex min-w-0 items-center gap-1.5 font-sans text-[16px] font-semibold leading-[24px] text-[#374151]"
            : emphasize
            ? "inline-flex min-w-0 items-center gap-1.5 font-sans text-[14px] font-semibold leading-[20px] text-[#374151]"
            : "inline-flex min-w-0 items-center gap-1.5 font-sans text-[14px] font-normal leading-[20px] text-[#6B7280]"
        }
      >
        <span>{label}</span>
        {tooltip && <InfoTooltip content={tooltip} />}
      </span>
      <span
        className={
          total
            ? "font-sans text-[16px] font-bold leading-[24px] text-[#111827] text-right"
            : emphasize
            ? "font-sans text-[15px] font-semibold leading-[22px] text-[#111827] text-right"
            : "font-sans text-[14px] font-normal leading-[20px] text-[#111827] text-right"
        }
      >
        {value}
      </span>
    </div>
  );
}

interface BuyQuote {
  fiatAmount: string;
  tglobalAmount: string;
  ammSpotPrice: string;
  /** AMM execution price in USDX per PLAT (post-slippage, pre-fee).
   *  Divide by `fiatToTusdRate` to express in the user's selected fiat. */
  ammEffectivePrice: string;
  /** Fiat→USDX rate from the quote. 1 for USD. */
  fiatToTusdRate: number;
  /** AMM price impact in basis points (100 bps = 1%). Lets the form
   *  surface large trades to the user — PLAT is the only path that
   *  routes through the AMM, so stables always read 0 here. */
  priceImpactBps: number;
  transakFees: { totalFee: number; feePercent: number; netCryptoAmount: number } | null;
}

// ─────────────────────────────────────────────────────────────────────
// SELL — token → fiat via Transak off-ramp
//
// All five supported tokens are sellable. PLAT is included because
// the cashout backend already special-cases it: when `token === "PLAT"`
// the operator first swaps it to USDX on the AMM and then runs the
// regular Transak cashout on the resulting USDX. From the user's POV
// this is a single Sell operation that lands fiat in their bank account,
// matching the legacy "Sell" flow on the old Trade page.
//
// We intentionally do NOT call `createSellOrderAction` here — that path
// would only credit USDX to the internal balance and stop short of the
// bank withdrawal, which isn't what users expect from "Sell".
//
// Quoting and submission go through the cashout pipeline for every
// token (`getCashoutQuoteAction` + route to /cashout for KYC + bank
// details). None of the off-ramp logic is removed.
// ─────────────────────────────────────────────────────────────────────

interface UnifiedSellQuote {
  /** Net amount the user will receive, in payout currency. */
  netReceive: number;
  /** AMM price impact in basis points, when the sale routes through the
   *  PLAT ↔ USDX pool (i.e. sellToken === "PLAT"). NULL for
   *  stable-token sells, which never touch the AMM. */
  priceImpactBps: number | null;
  /** Gross fiat value (before fees) — used to validate against minSellUsd. */
  grossFiat: number;
  /** Effective fiat-per-token rate, computed client-side as
   *  `fiatAmount / inputAmount` from this quote's own response. Used
   *  for the rate-label display so the user sees the price in their
   *  selected payout currency (e.g. "1 EURX = €1.16"). NOT used for
   *  threshold math — see `usdPerToken` for that. */
  conversionRate: number;
  /** USD-per-token rate (`tusdEquivalent / inputAmount`). Used to
   *  compare against the USD-denominated minimum cash-out threshold
   *  ($10.50) without unit-mixing — required because `conversionRate`
   *  above is in the payout currency (€/£/R$/etc.), and dividing a
   *  USD threshold by a non-USD rate produces nonsense token counts. */
  usdPerToken: number;
  /** Minimum cash-out threshold in USD (typically 10.50). */
  minSellUsd: number;
  /** Display rate, e.g. "1 PLAT = $1.45" or "1 USDX = $1.00". */
  rateLabel: string;
  /** Transak fee row label. */
  feeLabel: string;
}

function showPreparingWithdrawalPage(checkoutWindow: Window) {
  checkoutWindow.document.open();
  checkoutWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Preparing checkout | Exchange</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #f3f4f6;
        color: #0f172a;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        width: min(460px, 100%);
        border: 1px solid #e5e7eb;
        border-radius: 18px;
        padding: 42px 34px;
        text-align: center;
        background: #fff;
        box-shadow: 0 12px 32px rgba(15, 23, 42, .08);
      }
      .brand {
        width: 52px;
        height: 52px;
        margin-bottom: 24px;
        border-radius: 50%;
        object-fit: cover;
      }
      h1 {
        margin: 0 0 12px;
        color: #111827;
        font-size: 23px;
        line-height: 1.25;
        font-weight: 650;
      }
      p {
        margin: 0;
        color: #64748b;
        font-size: 15px;
        line-height: 1.55;
      }
      .status {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        margin-top: 28px;
        color: #0EA5E9;
        font-size: 14px;
        font-weight: 600;
      }
      .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid #bae6fd;
        border-top-color: #0ea5e9;
        border-radius: 50%;
        animation: spin .8s linear infinite;
      }
      .hint {
        margin-top: 28px;
        color: #94a3b8;
        font-size: 13px;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main class="card" aria-live="polite">
      <img class="brand" src="${window.location.origin}/icons/plat.svg" alt="Exchange" />
      <h1>Preparing your secure checkout</h1>
      <p>We are setting up your withdrawal with Transak. This may take a few seconds.</p>
      <div class="status"><span class="spinner"></span>Getting things ready...</div>
      <p class="hint">Please keep this tab open. You will be redirected automatically.</p>
    </main>
  </body>
</html>`);
  checkoutWindow.document.close();
}

/**
 * Pre-checkout tutorial modal for the Sell flow.
 *
 * Walks non-Web3 users through Transak's Source Wallet Info form — the
 * one truly intimidating part of the off-ramp where they have to declare
 * source-of-funds, select "Others" from the exchange list, and type
 * the platform's registered exchange name — followed by the "I've sent the payment" confirmation, which
 * the platform handles in the background.
 *
 * Popup-blocker contract (don't break this): the `window.open` for the
 * Transak tab is fired by the caller's `onConfirm`, which only runs from
 * Step 4's "Continue to Transak" or the Skip button — both synchronous
 * user gestures. Next/Back/Close transitions never trigger onConfirm.
 *
 * Persistence: the Skip button only renders once a user has finished a
 * full sale (status reaches `completed`) and the polling effect sets
 * `TUTORIAL_SEEN_KEY` in localStorage. First-time users walk all four
 * steps; veterans get a one-click bypass.
 */
const TUTORIAL_SEEN_KEY = "exchange:transak-sell-tutorial-seen";

/** Name the platform is registered under with the off-ramp provider (shown in step 3). */
const TRANSAK_EXCHANGE_NAME =
  process.env.NEXT_PUBLIC_TRANSAK_EXCHANGE_NAME || "Your Exchange Name";

const TUTORIAL_STEPS: {
  title: string;
  body: React.ReactNode;
  /**
   * Filename token under /tutorial/Transak_Tutorial_<img>.png. Decoupled
   * from the array index so steps can be inserted (e.g. the "2_25" / "2_75"
   * screenshots that sit between the original 2 and 3) without renaming
   * every asset.
   */
  img: string;
  alt: string;
}[] = [
  {
    img: "1",
    title: "Open the Wallet Type menu",
    body: (
      <>
        Open the{" "}
        <strong className="font-semibold text-[#111827]">Wallet Type</strong>{" "}
        menu. This tells Transak where the funds are coming from.
      </>
    ),
    alt: "Transak Source Wallet Info screen with the Wallet Type dropdown highlighted",
  },
  {
    img: "2",
    title: "Choose Exchange Wallet",
    body: (
      <>
        Select{" "}
        <strong className="font-semibold text-[#111827]">
          Exchange Wallet
        </strong>{" "}
        from the list. This tells Transak you&apos;re using an exchange.
      </>
    ),
    alt: "Wallet Type dropdown open with Exchange Wallet highlighted",
  },
  {
    img: "2_25",
    title: "Open Select Exchange Type",
    body: (
      <>
        Open{" "}
        <strong className="font-semibold text-[#111827]">
          Select Exchange Type
        </strong>
        . You&apos;ll choose the exchange category in the next step.
      </>
    ),
    alt: "Transak Source Wallet Info form with the Select Exchange Type dropdown highlighted",
  },
  {
    img: "2_75",
    title: "Scroll down and choose Others",
    body: (
      <>
        Scroll to the bottom of the list and select{" "}
        <strong className="font-semibold text-[#111827]">Others</strong>. It may
        appear after many exchanges.
      </>
    ),
    alt: "Select Exchange Type list scrolled to the bottom with Others highlighted",
  },
  {
    img: "3",
    title: "Type the platform's exchange name",
    body: (
      <>
        Type <strong className="font-semibold text-[#111827]">{TRANSAK_EXCHANGE_NAME}</strong> in
        the{" "}
        <strong className="font-semibold text-[#111827]">Exchange Name</strong>{" "}
        field. You can leave the nickname field empty.
      </>
    ),
    alt: "Exchange Name field highlighted, ready for the platform's exchange name",
  },
  {
    img: "4",
    title: "Press “Yes, I have paid”",
    body: (
      <>
        Press{" "}
        <strong className="font-semibold text-[#111827]">
          Yes, I have paid
        </strong>
        . You&apos;re not sending crypto — the platform handles the transfer.
      </>
    ),
    alt: "Transak Complete your transfer screen with the Yes, I have paid button highlighted",
  },
];

function WithdrawalTutorialModal({
  onCancel,
  onConfirm,
  submitting,
  mode = "precheckout",
}: {
  onCancel: () => void;
  /**
   * Required in `precheckout` mode (fires the cashout on Step 4 /
   * Skip). Ignored in `reference` mode, where the modal is purely
   * informational — both close paths route through `onCancel`.
   */
  onConfirm?: () => void;
  submitting: boolean;
  /**
   * `precheckout` (default) — opens the Sell flow, last button starts
   * the Transak cashout, Skip-to-Transak is offered to veteran users.
   * `reference` — opened from the in-flight cashout toast so the user
   * can re-read the instructions while the sale is already running on
   * Transak. No Skip, no "Continue to Transak"; the last step closes.
   */
  mode?: "precheckout" | "reference";
}) {
  const isReference = mode === "reference";
  const [step, setStep] = useState(1);
  // Skip is "earned" — only veterans who've completed a prior sale see
  // it. New users walk the full four steps. localStorage is the source
  // of truth; we snapshot it on mount so the skip button doesn't flicker
  // in mid-session if the value changes (it won't, but defensive).
  // Skip is also hidden in reference mode, where there's nothing to
  // skip to — the sale is already running.
  const [showSkip, setShowSkip] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isReference) return;
    try {
      setShowSkip(window.localStorage.getItem(TUTORIAL_SEEN_KEY) === "1");
    } catch {
      // localStorage can throw in private modes / quota-exceeded; treat
      // as not-seen and show the full tutorial.
    }
  }, [isReference]);

  // Escape closes — but only when nothing is in flight, so the user
  // can't accidentally dismiss while a cashout is being initiated
  // server-side after the final "Continue to Transak" click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  const total = TUTORIAL_STEPS.length;
  const current = TUTORIAL_STEPS[step - 1];
  const isLast = step === total;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdrawal-tutorial-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        // Backdrop click cancels — but not while a request is in flight.
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      {/* max-w-xl (not lg): the longest step title — "Type PLAT Crypto
          Services as the Exchange Name" — needs ~506px at 22px Work Sans
          semibold. lg's 448px content area wrapped it to two lines, which
          made the box taller on that step than the others; xl's 512px
          content fits it on one line so the modal stays one size across all
          six steps. */}
      <div className="relative w-full max-w-xl select-none rounded-[10px] bg-white px-6 pb-6 pt-4 shadow-xl sm:px-8 sm:pb-8 sm:pt-5">
        {/* Header row — title and close X share one flex row so the X is
            vertically centered with the blue title. `items-center` keeps them
            aligned even if the (longer) reference-mode title wraps. */}
        <div className="flex items-center justify-between gap-3">
          {/* Sentence case (no all-caps) so it reads as a calm, plain heading
              rather than a warning. Reopening from the in-flight toast shows
              the exact same tutorial — same title, same clean formatting —
              just without the steps that would re-trigger Transak. */}
          <p className="font-display text-[16px] sm:text-[18px] font-semibold text-[#0EA5E9]">
            Follow these simple steps
          </p>
          <ModalCloseButton
            onClick={onCancel}
            disabled={submitting}
            label="Close tutorial and return to Sell"
            size="lg"
            className="-mr-1"
          />
        </div>

        {/* Progress indicator — dots give a visual sense of position, the
            "Step X of Y" text keeps the count explicit (dots alone aren't
            enough). Dots are decorative; the text carries the a11y label. */}
        <div className="mt-1 flex items-center gap-3">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {TUTORIAL_STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-2 rounded-full transition-all ${
                  i + 1 === step
                    ? "w-5 bg-[#0EA5E9]"
                    : i + 1 < step
                    ? "w-2 bg-[#7DD3FC]"
                    : "w-2 bg-[#D1D5DB]"
                }`}
              />
            ))}
          </div>
          <span className="font-display text-[12px] font-medium text-[#6B7280]">
            Step {step} of {total}
          </span>
        </div>

        {/* Heading block — the title sits directly under the progress dots.
            Same layout whether the tutorial is opened before checkout or
            reopened mid-sale from the toast, so there's only one version of
            this screen. */}
        <div className="mt-3 flex flex-col gap-2">
          <h2
            id="withdrawal-tutorial-title"
            className="font-display text-[20px] font-semibold text-[#111827] sm:text-[22px]"
          >
            {current.title}
          </h2>
        </div>

        {/* Fixed-height, centered screenshot frame. Because the heading block
            above and the body zone below are also fixed/reserved height, this
            frame renders at exactly the same size on every step — the
            same-dimension PNGs never resize as the user steps through. */}
        <div className="mt-4 flex h-[50vh] items-center justify-center">
          {/* Render every image at once and load them all eagerly so there's
              no pop-in when the user advances to a step for the first time.
              Lazy loading on display:none images defers the fetch until they
              become visible, which caused a visible flash on each new step.
              The 6 tutorial PNGs total ~744KB and are only fetched when this
              (deliberately opened) modal mounts, so eager loading is cheap.
              Step 1 keeps fetchPriority="high" so it still paints first.
              Only the active step is visible; the rest are display:none.
              Native <img> keeps the tinified PNGs unmodified (Next/Image would
              re-encode to WebP and soften the annotation text). `img` is the
              asset token, not the index, so inserted steps (2_25 / 2_75)
              resolve correctly. */}
          {TUTORIAL_STEPS.map((s, i) => {
            const isActive = i + 1 === step;
            const isFirst = i === 0;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={s.img}
                src={`/tutorial/Transak_Tutorial_${s.img}.png`}
                width={1276}
                height={1956}
                loading="eager"
                fetchPriority={isFirst ? "high" : "auto"}
                alt={s.alt}
                draggable={false}
                className={`block h-full w-auto max-w-full object-contain ${
                  isActive ? "" : "hidden"
                }`}
              />
            );
          })}
        </div>

        {/* Reserved-height body zone. Every step's copy is two lines, so this
            is sized to ~2 lines (44px text + small buffer): tight against the
            footer while still giving all steps the same height so the CTA
            doesn't shift between steps. */}
        <div className="mt-4 min-h-[48px]">
          <p className="font-display text-[14px] leading-[22px] text-[#4B5563]">
            {current.body}
          </p>
        </div>

        <div className="mt-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
                disabled={submitting}
                className="min-h-[48px] w-full rounded-[8px] border border-[#E5E7EB] bg-white px-4 font-display text-[14px] font-semibold text-[#4B5563] transition-colors hover:bg-[#F9FAFB] disabled:opacity-50"
              >
                Back
              </button>
            ) : (
              <div aria-hidden className="hidden sm:block" />
            )}
          <button
            type="button"
            onClick={() => {
              if (isLast) {
                if (isReference) {
                  onCancel();
                } else {
                  onConfirm?.();
                }
              } else {
                setStep((s) => Math.min(total, s + 1));
              }
            }}
            disabled={submitting}
            className="min-h-[48px] w-full rounded-[8px] bg-[#0EA5E9] px-4 font-display text-[14px] font-semibold text-white transition-colors hover:bg-[#0284C7] disabled:opacity-60"
          >
            {isLast
              ? isReference
                ? "Got it"
                : submitting
                ? "Opening…"
                : "Continue to Transak"
              : "Next"}
          </button>
          </div>
          {!isReference && showSkip && !isLast && (
            <button
              type="button"
              onClick={() => onConfirm?.()}
              disabled={submitting}
              className="mt-3 w-full rounded-[8px] px-3 py-2 text-center font-display text-[13px] font-medium text-[#6B7280] underline-offset-4 transition-colors hover:text-[#111827] hover:underline disabled:opacity-50"
            >
              Skip tutorial and proceed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation modal before the destructive Cancel-sale path.
 *
 * Renders token-aware copy so the user knows exactly what they're
 * getting back: PLAT refunds as USDX (the AMM swap is already
 * on-chain by the time the cashout is cancellable), every other token
 * refunds in-kind. USDX sales get a simpler message that drops the
 * "converted to USDX" line entirely.
 *
 * Refund is the blue primary (right) and "Don't cancel sale" is the
 * outlined secondary (left). A user opening this modal has already
 * pressed Cancel once on the toast — refund is what they're trying to
 * do, so it gets the visual weight; the outlined option lets them back
 * out if they clicked through by mistake.
 */
function CancelSaleConfirmModal({
  sourceToken,
  onCancel,
  onConfirm,
  submitting,
}: {
  sourceToken: string | undefined;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  submitting: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  // What the user will actually receive back. PLAT is special-cased
  // because the AMM swap to USDX has already settled on-chain at this
  // point. The undefined branch is a defensive fallback — sourceToken
  // is now populated on every code path that sets activeCashout, but a
  // future caller might forget; safer to render generic copy than crash.
  const refundToken = sourceToken === "PLAT" ? "USDX" : sourceToken;
  const showConvertedLine = sourceToken === "PLAT";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-sale-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-[10px] bg-white p-6 shadow-xl sm:p-8">
        <h2
          id="cancel-sale-title"
          className="font-display text-[20px] font-semibold text-[#111827] sm:text-[22px]"
        >
          Cancel this sale?
        </h2>
        <div className="mt-3 space-y-3 font-display text-[14px] leading-[22px] text-[#4B5563]">
          {showConvertedLine && (
            <p>
              Your{" "}
              <strong className="font-semibold text-[#111827]">PLAT</strong>{" "}
              has already been converted to{" "}
              <strong className="font-semibold text-[#111827]">USDX</strong>{" "}
              for this sale.
            </p>
          )}
          <p>
            Cancelling now will instantly refund{" "}
            {refundToken ? (
              <>
                your{" "}
                <strong className="font-semibold text-[#111827]">
                  {refundToken}
                </strong>{" "}
                to your balance.
              </>
            ) : (
              "your tokens to your balance."
            )}
          </p>
          <p className="text-[13px] text-[#6B7280]">
            If you change your mind, you can start a new sale anytime.
          </p>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="min-h-[40px] w-full rounded-[8px] border-2 border-[#E5E7EB] bg-white px-4 font-display text-[14px] font-semibold text-[#4B5563] transition-colors hover:bg-[#F9FAFB] disabled:opacity-50"
          >
            Don&apos;t Cancel Sale
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="min-h-[40px] w-full rounded-[8px] bg-[#0EA5E9] px-4 font-display text-[14px] font-semibold text-white transition-colors hover:bg-[#0284C7] disabled:opacity-60"
          >
            {submitting
              ? "Refunding…"
              : refundToken
              ? `Cancel Sale and Refund in ${refundToken}`
              : "Cancel Sale and Refund my Tokens"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation dialog for cancelling an in-flight purchase (Buy mode).
 * Buy's analogue of CancelSaleConfirmModal — simpler because there's nothing
 * to refund: the user hasn't paid Transak yet, so the only outcome is the
 * pending order being dropped. The "already processing" edge case is handled
 * by the server guard (cancelBuyOrderAction / cancelStableTopUpAction), whose
 * error message surfaces back through the toast if the user is too late.
 */
function CancelBuyConfirmModal({
  onCancel,
  onConfirm,
  submitting,
}: {
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  submitting: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-buy-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-[10px] bg-white p-6 shadow-xl sm:p-8">
        <h2
          id="cancel-buy-title"
          className="font-display text-[20px] font-semibold text-[#111827] sm:text-[22px]"
        >
          Cancel this purchase?
        </h2>
        <div className="mt-3 space-y-3 font-display text-[14px] leading-[22px] text-[#4B5563]">
          <p>
            You haven&apos;t been charged — cancelling just drops this pending
            order.
          </p>
          <p className="text-[13px] text-[#6B7280]">
            If your Transak payment is already being processed it can no longer
            be cancelled. You can start a new purchase anytime.
          </p>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="min-h-[40px] w-full rounded-[8px] border border-[#E5E7EB] bg-white px-4 font-display text-[14px] font-semibold text-[#4B5563] transition-colors hover:bg-[#F9FAFB] disabled:opacity-50"
          >
            Keep Purchase
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="min-h-[40px] w-full rounded-[8px] bg-[#0EA5E9] px-4 font-display text-[14px] font-semibold text-white transition-colors hover:bg-[#0284C7] disabled:opacity-60"
          >
            {submitting ? "Cancelling…" : "Cancel Purchase"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SellForm({
  balances,
  loading = false,
  onComplete,
  pushToast,
  onSidebarChange,
}: {
  balances: { token_symbol: string; balance: string }[];
  /**
   * True while the parent snapshot fetch is in flight. Swaps the live
   * balance number for a skeleton pulse and suppresses the MAX shortcut
   * so users can't fill the input with "0.00" before the real balance
   * lands.
   */
  loading?: boolean;
  onComplete: () => void | Promise<void>;
  pushToast: (t: Omit<Toast, "id">) => void;
  onSidebarChange?: (context: RateCardContext) => void;
}) {
  // Sell is locked to PLAT. The off-ramp/cashout actions still accept
  // any PLAT token (the PLAT→USDX hop Transak needs happens under the
  // hood), so re-introducing a TokenDropdown here is all it takes to expose
  // the other tokens again.
  const [sellToken] = useState<TokenSymbol>("PLAT");
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>("USD");
  const [sellAmount, setSellAmount] = useState("");
  // When MAX is clicked we want a clean 2-decimal display value in the
  // input AND a full-precision actual amount for submit/quote so the
  // wallet drains to true zero (no sub-cent dust). `exactSellAmount`
  // holds the raw balance string set by the MAX handler; user input via
  // `handleAmountChange` clears it back to null so manual typing uses
  // the (already-2-decimal-capped) input value directly.
  const [exactSellAmount, setExactSellAmount] = useState<string | null>(null);
  // Receive-side (fiat) input is editable too — users often know the
  // payout they want, not how many tokens to sell. `lastEditedField`
  // tracks which side drove the latest quote so we know whether to
  // forward-quote (sell → receive) or inversely derive the token amount
  // from a target fiat payout. Mirrors BuyForm's pay/receive wiring.
  const [receiveAmount, setReceiveAmount] = useState("");
  const [lastEditedField, setLastEditedField] = useState<"sell" | "receive">(
    "sell"
  );
  const [quote, setQuote] = useState<UnifiedSellQuote | null>(null);
  // Reference fiat-per-token rate, fetched before the user types so the
  // right-rail exchange-rate card has a value to show. Refreshes whenever
  // the source token or payout currency changes; the live `quote` rate
  // takes precedence when present. No longer shown inline on the form —
  // the rate lives in the right rail + the review modal now.
  const [displayRateValue, setDisplayRateValue] = useState<number | null>(null);
  // Initialised to `true` so the rail's rate skeleton paints on first
  // frame (most visible on PLAT where the AMM round-trip is slower
  // than the Chainlink stablecoin rate lookups).
  const [loadingDisplayRate, setLoadingDisplayRate] = useState(true);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Sale-review modal — the new first gate the CTA opens (mirrors Buy's
  // "Review Purchase"). Confirming it opens `confirmOpen` (the tutorial).
  const [reviewOpen, setReviewOpen] = useState(false);
  // Pre-checkout tutorial modal. Opened from the review modal's Continue
  // button (not directly by the CTA anymore). Its final step is what
  // briefs the user on the "I've sent the payment" step and fires the
  // Transak tab — that synchronous window.open must stay attached here.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Raw server-provided balance string — preserved at full precision so
  // MAX can drain the wallet exactly. parseFloat-then-toString round-
  // tripping can lose ULP precision for some values; using the string the
  // server actually sent avoids that and keeps the on-chain math exact.
  const rawTokenBalance =
    balances.find((b) => b.token_symbol === sellToken)?.balance ?? "0";
  const tokenBalance = parseFloat(rawTokenBalance);

  useEffect(() => {
    let cancelled = false;
    let resolved = false;
    setLoadingDisplayRate(true);

    const apply = (
      res: Awaited<ReturnType<typeof getCashoutQuoteAction>>
    ) => {
      if (cancelled || resolved) return;
      resolved = true;
      if (res.success) {
        const ratePerToken = parseFloat(res.data.fiatAmount);
        setDisplayRateValue(
          Number.isFinite(ratePerToken) ? ratePerToken : null
        );
      } else {
        setDisplayRateValue(null);
      }
      setLoadingDisplayRate(false);
    };

    // Reference amount of "1" keeps the AMM quote fast and avoids any
    // liquidity sensitivity — for the four PLAT stablecoins the rate is
    // constant per token; for PLAT it's the spot price.
    const fetchOnce = () =>
      getCashoutQuoteAction(sellToken, "1", fiatCurrency)
        .then(apply)
        .catch(() => apply({ success: false, error: "fetch_failed" }));

    fetchOnce();

    // Defensive retry: the very first server-action call after a route
    // change can stall on Next.js dev's lazy chunk compile, which
    // leaves the skeleton spinning. If we haven't resolved in 4 s, fire
    // a parallel attempt — whichever resolves first wins via `resolved`.
    const retryId = setTimeout(() => {
      if (!resolved && !cancelled) fetchOnce();
    }, 4000);

    // Hard ceiling: if both attempts hang, clear the skeleton so the
    // user isn't stuck. A late response can still populate `displayRate`
    // through `apply` until the effect is torn down.
    const giveUpId = setTimeout(() => {
      if (resolved || cancelled) return;
      setLoadingDisplayRate(false);
    }, 10000);

    return () => {
      cancelled = true;
      clearTimeout(retryId);
      clearTimeout(giveUpId);
    };
  }, [sellToken, fiatCurrency]);

  // Sell-driven quote (forward): user typed in "You sell", we forward-quote
  // and write the net payout into "You receive". Bails when the receive
  // side is the active editor so we never overwrite their typed target.
  useEffect(() => {
    if (lastEditedField !== "sell") return;
    // Invalidate the prior quote synchronously on every input change.
    // It was priced for the previous sellAmount/token/currency and must
    // not gate the submit button or chip until the fresh debounced quote
    // lands. Without this, a fast keystroke (e.g. erasing a digit from
    // an over-balance amount down to a sub-minimum one) briefly left
    // the stale quote satisfying both `!insufficient` and the minimum
    // check, enabling submit against pre-debounce state.
    setQuote(null);

    // When MAX is active, quote against the full-precision raw balance so
    // the receive amount the user sees is what they'll actually get.
    // Otherwise use the input value directly.
    const submitAmount = exactSellAmount ?? sellAmount;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const v = parseFloat(submitAmount);
      if (!Number.isFinite(v) || v <= 0) {
        setQuote(null);
        setReceiveAmount("");
        return;
      }
      setLoadingQuote(true);

      // Single quote path for every token, including PLAT — the
      // cashout backend handles the PLAT → USDX AMM swap server-side
      // before the Transak step, and `getCashoutQuoteAction` returns a
      // single combined quote (rate + fees) for it.
      const res = await getCashoutQuoteAction(sellToken, submitAmount, fiatCurrency);
      if (cancelled) return;
      setLoadingQuote(false);
      if (res.success) {
        const q = res.data;
        const grossFiat = parseFloat(q.fiatAmount);
        const tusdEquivalent = parseFloat(q.tusdEquivalent);
        // Derive both rates from this quote's own fields — fiat-per-token
        // for display (matches the payout currency), USD-per-token for
        // the threshold math (so it's unit-consistent with $10.50 min).
        const effectiveRate = v > 0 ? grossFiat / v : 0;
        const usdPerToken = v > 0 ? tusdEquivalent / v : 0;
        setQuote({
          netReceive: parseFloat(q.netReceive),
          // AMM details are only populated when PLAT is the sell
          // token — for stable sells `ammDetails` is undefined because
          // there's no AMM leg, so we record NULL and the impact row
          // renders "None".
          priceImpactBps: q.ammDetails?.priceImpactBps ?? null,
          grossFiat,
          conversionRate: effectiveRate,
          usdPerToken,
          minSellUsd: q.minSellUsd,
          rateLabel: `1 ${sellToken} = ${formatFiat(effectiveRate, fiatCurrency, { maxFractionDigits: 2 })}`,
          // Just the fee amount — percentage was misleading because it
          // varied with the entered amount and didn't add user value.
          feeLabel: formatUsd(parseFloat(q.transakFeeAmount)),
        });
        // Mirror the net payout into the editable receive field so the
        // sell-driven direction stays in sync.
        setReceiveAmount(formatFixed2(Math.max(0, parseFloat(q.netReceive))));
      } else {
        // Quote failures during typing stay silent — see BuyForm.
        setQuote(null);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sellToken, sellAmount, exactSellAmount, fiatCurrency, lastEditedField]);

  // Receive-driven quote (inverse): user typed in "You receive", we
  // estimate the tokens needed from the current reference rate (plus a
  // small buffer for the cash-out fee), set "You sell" to that estimate,
  // and forward-quote it. The user's typed fiat value stays sticky.
  useEffect(() => {
    if (lastEditedField !== "receive") return;
    // Invalidate the prior quote synchronously so the chip/CTA can't gate
    // on stale numbers while the debounced refetch runs. Same defensive
    // pattern as the sell-driven effect and BuyForm.
    setQuote(null);

    let cancelled = false;
    const timer = setTimeout(async () => {
      const targetFiat = parseFloat(receiveAmount);
      if (!Number.isFinite(targetFiat) || targetFiat <= 0) {
        setQuote(null);
        setSellAmount("");
        setExactSellAmount(null);
        setLoadingQuote(false);
        return;
      }
      if (displayRateValue == null || displayRateValue <= 0) {
        // Reference rate not loaded yet — wait; this effect re-fires once
        // displayRateValue populates.
        return;
      }
      // `displayRateValue` is the gross fiat-per-token rate. To net the
      // target payout after the cash-out fee, gross ≈ target / 0.95
      // (~5% buffer), then tokens = gross / rate. Residual difference
      // versus the precise fee is reconciled by the forward quote.
      const tokensForQuote = (
        (targetFiat / 0.95) /
        displayRateValue
      ).toFixed(2);
      // Reflect the receive-driven estimate in sellAmount immediately so
      // the balance / minimum checks evaluate against it even if the quote
      // API rejects the amount. A manually-derived amount is never a MAX
      // drain, so clear any exact full-precision capture.
      setSellAmount(tokensForQuote);
      setExactSellAmount(null);

      setLoadingQuote(true);
      const res = await getCashoutQuoteAction(
        sellToken,
        tokensForQuote,
        fiatCurrency
      );
      if (cancelled) return;
      setLoadingQuote(false);
      if (res.success) {
        const q = res.data;
        const tokens = parseFloat(tokensForQuote);
        const grossFiat = parseFloat(q.fiatAmount);
        const tusdEquivalent = parseFloat(q.tusdEquivalent);
        const effectiveRate = tokens > 0 ? grossFiat / tokens : 0;
        const usdPerToken = tokens > 0 ? tusdEquivalent / tokens : 0;
        setQuote({
          netReceive: parseFloat(q.netReceive),
          priceImpactBps: q.ammDetails?.priceImpactBps ?? null,
          grossFiat,
          conversionRate: effectiveRate,
          usdPerToken,
          minSellUsd: q.minSellUsd,
          rateLabel: `1 ${sellToken} = ${formatFiat(effectiveRate, fiatCurrency, { maxFractionDigits: 2 })}`,
          feeLabel: formatUsd(parseFloat(q.transakFeeAmount)),
        });
      } else {
        setQuote(null);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [receiveAmount, lastEditedField, sellToken, fiatCurrency, displayRateValue]);

  // MAX fills the input with the raw balance string, so parseFloat of
  // the input is exactly === tokenBalance — strict comparison passes.
  // Manual typing still trips this if the user enters more than they
  // hold, including the rounding-up edge case.
  const enteredSell = parseFloat(sellAmount || "0");
  const insufficient =
    Number.isFinite(enteredSell) &&
    enteredSell > 0 &&
    enteredSell > tokenBalance;

  // Live minimum-amount validation. Cashouts below ~$10.50 USD gross are
  // rejected by Transak, so we surface this immediately while the user
  // is typing instead of waiting for the Sell click to fail.
  const belowMinimum =
    !!quote && quote.grossFiat > 0 && quote.grossFiat < quote.minSellUsd;
  // Suggested token amount that clears the minimum cash-out threshold.
  // Uses USD-per-token (NOT the payout-currency rate) because the
  // threshold itself is denominated in USD. Mixing units here was the
  // bug that made the suggested amount swing wildly between EUR/GBP/
  // BRL/USD payouts. Stable across typing (depends only on quote, not
  // on `sellAmount`). Rounded up to the nearest 0.01 so the suggested
  // value safely clears the threshold.
  const minTokensToReachThreshold =
    belowMinimum && quote && quote.usdPerToken > 0
      ? Math.ceil((quote.minSellUsd / quote.usdPerToken) * 100) / 100
      : null;

  // Feed the right-rail exchange-rate card. Prefer the live quote's
  // fiat-per-token rate; fall back to the reference rate before the user
  // types. Mirrors BuyForm's onSidebarChange wiring.
  const sidebarRate =
    quote && Number.isFinite(quote.conversionRate)
      ? quote.conversionRate
      : displayRateValue;
  const sidebarRateLoading =
    (loadingQuote && enteredSell > 0) ||
    (loadingDisplayRate && sidebarRate == null);

  useEffect(() => {
    onSidebarChange?.({
      token: sellToken,
      fiatCurrency,
      rate: sidebarRate,
      loadingRate: sidebarRateLoading,
    });
  }, [onSidebarChange, sellToken, fiatCurrency, sidebarRate, sidebarRateLoading]);

  const handleSubmit = async () => {
    if (!quote || insufficient) return;

    // Reserve a user-authorized checkout tab before the server may debit
    // the balance. That tab is navigated to Transak after session creation.
    const transakWindow = window.open("about:blank", "_blank");
    if (!transakWindow) {
      pushToast({
        variant: "warning",
        title: "Pop-ups blocked",
        description:
          "Please allow pop-ups for this site, then try again.",
      });
      return;
    }
    // Keep the user-authorized tab alive while the cashout/session is
    // created; a new window.open after that await can be blocked.
    showPreparingWithdrawalPage(transakWindow);
    transakWindow.opener = null;

    setSubmitting(true);
    // Per-submission idempotency key — coalesces accidental double clicks
    // into a single cashout order at the backend.
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `cashout-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Use the exact full-precision balance when MAX is active; otherwise
    // the input value (already 2-decimal-capped by NumberInput).
    const submitAmount = exactSellAmount ?? sellAmount;

    let res: Awaited<ReturnType<typeof initiateCashoutTransakAction>>;
    try {
      res = await initiateCashoutTransakAction(
        sellToken,
        submitAmount,
        fiatCurrency,
        idempotencyKey
      );
    } catch {
      setSubmitting(false);
      transakWindow.close();
      pushToast({
        variant: "error",
        title: "Sell failed",
        description: "Unable to start the Transak checkout. Please try again.",
      });
      return;
    }
    setSubmitting(false);
    if (!res.success) {
      transakWindow.close();
      pushToast({
        variant: "error",
        title: "Sell failed",
        description: res.error,
      });
      return;
    }
    // The server has already debited the user's balance and is awaiting
    // the wallet redirect from Transak.
    transakWindow.location.replace(res.data.widgetUrl);
    // No "Transak opened" toast here — the tutorial modal already
    // briefed the user on the ID-check + "Yes, I have paid" step, and
    // by this point the Transak tab has focus so any toast we push in
    // the now-background tab would just go unread.
    setSellAmount("");
    setReceiveAmount("");
    setLastEditedField("sell");
    setExactSellAmount(null);
    setQuote(null);
    void onComplete();
  };

  // Subtitle and fineprint are now token-agnostic. The PLAT→USDX
  // intermediate swap (needed because Transak only takes USDX off-ramp)
  // happens automatically under the hood — non-Web3 users don't have a
  // mental model for AMM hops, so we don't expose it. Mirrors the Buy
  // box treatment for the USDX→other-stable conversion step.

  return (
    <FormCard>
      <FormTitle
        title="Sell PLAT"
        subtitle="Sell your PLAT and receive the funds in your bank account or card."
      />

      <div className="relative mt-9 space-y-3">
        <FieldShell
          label="You Sell"
          bodyCentered
          sideText={
            <span className="font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
              Current balance:{" "}
              {loading ? (
                <span
                  aria-hidden
                  className="inline-block h-[12px] w-[80px] rounded bg-[#E5E7EB] animate-pulse align-middle"
                />
              ) : (
                <>
                  <span className="font-semibold text-[#6B7280]">
                    {formatBalance(tokenBalance)} {sellToken}
                  </span>{" "}
                  <span className="font-semibold text-[#6B7280]">·</span>{" "}
                  <button
                    type="button"
                    onClick={() => {
                      // Dust-only or empty balances: MAX is a no-op. The
                      // raw balance string can still carry sub-cent
                      // precision (e.g. 0.0059) even when the displayed
                      // balance reads "0.00" — letting it land in
                      // `exactSellAmount` lets the quote action succeed
                      // for that tiny amount and enables the CTA for an
                      // order the server can't fulfill.
                      // MAX is a sell-driven action — the payout field is
                      // derived from the drained balance.
                      setLastEditedField("sell");
                      const floored = floorToCents(tokenBalance);
                      if (floored < DUST_BALANCE) {
                        setSellAmount("0.00");
                        setExactSellAmount(null);
                        return;
                      }
                      // Display: clean 2-decimal floor so the input doesn't
                      // show on-chain 18-decimal noise. Submit/quote: the
                      // raw balance string so the wallet drains to true
                      // zero with no sub-cent dust. `floorToCents` keeps
                      // the display ≤ the real balance so the insufficient
                      // check can't false-positive on the rounded value.
                      setSellAmount(floored.toFixed(2));
                      setExactSellAmount(rawTokenBalance);
                    }}
                    className="font-sans text-[12px] font-semibold leading-[18px] text-[#0284C7] underline underline-offset-2 hover:text-[#3EB7ED]"
                  >
                    MAX
                  </button>
                </>
              )}
            </span>
          }
        >
          <NumberInput
            value={sellAmount}
            onChange={(v) => {
              setSellAmount(v);
              // User edited away from a MAX click — drop the exact full-
              // precision amount so quote + submit fall back to what's
              // visibly in the input.
              setExactSellAmount(null);
              setLastEditedField("sell");
            }}
            placeholder="0.00"
            maxDecimals={2}
            suffix={sellToken}
            showSuffixWhenEmpty
            align="left"
          />
          <FixedTokenLabel value={sellToken} />
        </FieldShell>

        <DownConnector />

        <FieldShell
          variant="input"
          label="You Receive"
          bodyCentered
        >
          <NumberInput
            value={receiveAmount}
            onChange={(v) => {
              setReceiveAmount(v);
              setLastEditedField("receive");
            }}
            placeholder={loadingQuote ? "…" : "0.00"}
            maxDecimals={2}
            prefix={FIAT_SYMBOLS[fiatCurrency]}
            suffix={fiatCurrency}
            showSuffixWhenEmpty
            align="left"
          />
          <CurrencyDropdown
            value={fiatCurrency}
            options={FIAT_OPTIONS}
            header="Receive in Card / Bank"
            bare
            style={{ transform: "translateY(-8px)" }}
            onChange={(v) => setFiatCurrency(v as FiatCurrency)}
          />
        </FieldShell>
      </div>

      <div className="mt-6">
        <StatusChip
          className="mb-6"
          {...((): ChipState => {
            const hasSellInput =
              !!sellAmount && parseFloat(sellAmount) > 0;
            if (!hasSellInput) {
              return {
                variant: "info",
                message: "Please enter an amount to sell.",
              };
            }
            if (insufficient) {
              return {
                variant: "warning",
                message: `You only have ${formatBalance(
                  tokenBalance
                )} ${sellToken} available to sell.`,
              };
            }
            if (belowMinimum && quote && minTokensToReachThreshold != null) {
              return {
                variant: "warning",
                message: `Minimum sale is ${formatFixed2(
                  minTokensToReachThreshold
                )} ${sellToken}.${
                  tokenBalance < minTokensToReachThreshold
                    ? ` Convert tokens to ${sellToken} or buy more to proceed.`
                    : ""
                }`,
              };
            }
            // Quote hasn't arrived yet (350 ms debounce + network). Avoid
            // flashing the green "Ready" chip — we can't know if the entered
            // amount clears the minimum until the quote lands. The submit
            // button is already disabled by `!quote`, but the chip falls
            // through to "ready" without this guard.
            if (!quote) {
              return {
                variant: "info",
                message: "Calculating quote…",
              };
            }
            return {
              variant: "ready",
              message:
                "Ready to proceed — continue to cashout (a quick ID check may be required).",
            };
          })()}
        />

        <div>
          <PrimaryButton
            label="Review Sale"
            loading={submitting}
            disabled={
              !sellAmount ||
              parseFloat(sellAmount) <= 0 ||
              !quote ||
              submitting ||
              insufficient ||
              belowMinimum
            }
            onClick={() => setReviewOpen(true)}
          />
        </div>

        <div className="!mt-4 -mb-1 sm:-mb-2 lg:-mb-3">
          <Fineprint text="PLAT Token sales are processed by our partner Transak. Your funds arrive once Transak completes the payout." />
        </div>
      </div>

      {reviewOpen && quote && (
        <SellReviewModal
          token={sellToken}
          tokenAmount={`${formatFixed2(parseFloat(sellAmount || "0"))} ${sellToken}`}
          exchangeRate={quote.rateLabel}
          grossAmount={formatFiat(quote.grossFiat, fiatCurrency)}
          cashOutFee={formatFiat(
            Math.max(0, quote.grossFiat - quote.netReceive),
            fiatCurrency
          )}
          netReceive={formatFiat(Math.max(0, quote.netReceive), fiatCurrency)}
          priceEffect={
            sellToken === "PLAT" && (quote.priceImpactBps ?? 0) >= 500 ? (
              <PriceImpactValue bps={quote.priceImpactBps ?? 0} direction="down" />
            ) : null
          }
          loading={submitting}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => {
            // Hand off to the tutorial. Transak is NOT opened here — the
            // tutorial's final-step button keeps the synchronous
            // window.open (popup-blocker contract). The review modal is
            // just the details gate that precedes it.
            setReviewOpen(false);
            setConfirmOpen(true);
          }}
        />
      )}

      {confirmOpen && (
        <WithdrawalTutorialModal
          submitting={submitting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            // handleSubmit catches its own errors and pushes toasts — it
            // never throws — so the modal close runs unconditionally.
            await handleSubmit();
            setConfirmOpen(false);
          }}
        />
      )}
    </FormCard>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SWAP  — token ↔ token (fully in-app, calls executeSwapAction)
// ─────────────────────────────────────────────────────────────────────

const CONVERT_TOKENS: TokenSymbol[] = [
  "PLAT",
  "USDX",
  "EURX",
  "GBPX",
  "BRLX",
];

/**
 * Unified Convert quote — covers both flavours so the rest of the form
 * doesn't have to branch on which action produced the numbers. The fields
 * exposed are the strict superset every render code-path needs.
 */
interface UnifiedConvertQuote {
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  fromAmount: string;
  toAmount: string;
  /** Display rate: 1 fromToken = X toToken. */
  rate: number;
  /** USD value of `fromAmount` — drives the daily-limit progress row. */
  fromUSDValue: number;
  /** True for AMM-involving converts so the UI can label fees etc. */
  involvesAmm: boolean;
  /** AMM price impact in basis points. NULL for stable↔stable Convert
   *  (no AMM hop). For AMM-involving Convert, populated from the underlying
   *  `quoteSwap` call. */
  priceImpactBps: number | null;
}

function ConvertForm({
  balances,
  loading = false,
  onComplete,
  pushToast,
  setActiveConvert,
  onSidebarChange,
}: {
  balances: { token_symbol: string; balance: string }[];
  /**
   * True while the parent snapshot fetch is in flight. Swaps both the
   * From and To balance numbers for skeleton pulses and suppresses the
   * MAX shortcut on the From field so users can't fill the input with
   * "0.00" before the real balance lands.
   */
  loading?: boolean;
  onComplete: () => void | Promise<void>;
  pushToast: (t: Omit<Toast, "id">) => void;
  /**
   * Sets / clears the parent's in-flight banner. Called with a populated
   * object before the execute await, then with null when the await
   * resolves (success, failure, or thrown). Fires for both AMM and
   * stable↔stable paths — the banner is intentionally brief for the
   * sub-second ledger path, for UX consistency with Buy / Sell.
   */
  setActiveConvert: (c: ActiveConvert | null) => void;
  /**
   * Feeds the right-rail exchange-rate card. Convert is token→token, so
   * the context carries a `quoteToken` (the receive side). Mirrors
   * BuyForm / SellForm's onSidebarChange wiring.
   */
  onSidebarChange?: (context: RateCardContext) => void;
}) {
  const [fromToken, setFromToken] = useState<TokenSymbol>("USDX");
  const [toToken, setToToken] = useState<TokenSymbol>("EURX");
  const [fromAmount, setFromAmount] = useState("");
  // Editable "To" amount. Convert is now bidirectional (mirrors SellForm):
  // typing here drives an inverse quote back into `fromAmount`. The forward
  // (from-driven) effect writes the computed receive amount here.
  const [toAmount, setToAmount] = useState("");
  // Which side the user last drove. Gates the two quote effects so neither
  // overwrites the field the user is actively typing in. See SellForm.
  const [lastEditedField, setLastEditedField] = useState<"from" | "to">("from");
  // Full-precision raw balance set by MAX; cleared on manual input. See
  // `exactSellAmount` in SellForm for the rationale — keeps the input
  // visually at 2 decimals while still draining the wallet exactly.
  const [exactFromAmount, setExactFromAmount] = useState<string | null>(null);
  const [quote, setQuote] = useState<UnifiedConvertQuote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Gates execution behind a review modal (parity with Buy/Sell). The footer
  // CTA opens this; confirming inside the modal runs handleConvert.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Reference fromToken→toToken rate (per 1 fromToken), used by the inverse
  // (to-driven) effect to estimate the fromAmount needed for a typed receive
  // target. For stable↔stable it's constant; for AMM it's the spot estimate,
  // reconciled by the forward re-quote. Mirrors SellForm's displayRateValue.
  const [displayRateValue, setDisplayRateValue] = useState<number | null>(null);
  // Initialised true so the rail's rate skeleton paints on first frame
  // (AMM pairs round-trip slower than the Chainlink stablecoin lookups).
  const [loadingDisplayRate, setLoadingDisplayRate] = useState(true);

  // Raw server-provided balance string — preserved at full precision so
  // MAX can drain the wallet exactly (see SellForm for the rationale).
  const rawFromBalance =
    balances.find((b) => b.token_symbol === fromToken)?.balance ?? "0";
  const fromBalance = parseFloat(rawFromBalance);
  // Receive-side balance — shown above the "to" dropdown so users can see
  // their current holding of the token they're converting into. Display-
  // only (no MAX: you don't spend the receive token).
  const toBalance = parseFloat(
    balances.find((b) => b.token_symbol === toToken)?.balance ?? "0"
  );

  // Detect PLAT on either side — this is what routes the request
  // through the AMM-aware convert path instead of the ledger-only one.
  const involvesPlat =
    fromToken === "PLAT" || toToken === "PLAT";

  // Daily limit math comes straight from the quote so the math matches
  // what the server's security check will see at submit time.
  const dailySpent = quote ? quote.fromUSDValue : 0;
  const dailyCap = 5_000;

  // Surfaced as an inline yellow chip (not the red error banner) — same
  // affordance as the other live-validation warnings on the page.
  const sameTokens = fromToken === toToken;

  // Pre-emptive insufficient-balance check (Stake/Unstake have the same
  // pattern). Disables the button + shows a yellow chip *before* the
  // user clicks, rather than letting them submit and bounce a red error.
  const enteredFrom = parseFloat(fromAmount || "0");
  // The balance is displayed rounded to 2 decimals (`formatBalance`), and
  // the input is capped to 2 decimals too — so the user can only ever type
  // the *displayed* balance, which may round a hair above the true balance
  // (e.g. true 6.109 shows as "6.11"). Comparing the typed value against
  // the full-precision balance with a strict `>` therefore rejected the
  // very number we told the user they had. Compare in whole cents instead:
  // "insufficient" only when the typed amount exceeds the displayed balance.
  const enteredCents = Math.round(enteredFrom * 100);
  const balanceCents = Math.round(fromBalance * 100);
  const convertInsufficient =
    Number.isFinite(enteredFrom) && enteredFrom > 0 && enteredCents > balanceCents;
  // When the typed amount lands within rounding distance of the true
  // balance (i.e. the user typed their displayed max), convert the exact
  // raw balance instead — same behaviour as the MAX shortcut — so the
  // server doesn't reject an amount a fraction of a cent over the wallet.
  const overByRounding = enteredFrom > fromBalance && !convertInsufficient;

  // Minimum-amount floor. For stable↔stable the 5-token floor maps to a
  // ~$5 floor (all stables are ~$1 peg). For PLAT converts the
  // user-facing minimum is denominated in the source token, so 5 of any
  // stable still floors at ~$5 of value (slightly higher for PLAT
  // since 1 PLAT > $1, but that's acceptable — it just enforces a
  // slightly higher minimum-USD floor for AMM-involving converts, which
  // is appropriate given the AMM fee).
  const belowMinConvert =
    Number.isFinite(enteredFrom) &&
    enteredFrom > 0 &&
    enteredFrom < MIN_CONVERT_AMOUNT;

  // Pre-emptive daily-limit check. Server enforces this regardless; we
  // mirror it on the client so the user never has to click to learn.
  const exceedsDailyCap = dailySpent > dailyCap;

  // Reference-rate fetch (per 1 fromToken → toToken). Drives the inverse
  // (to-driven) estimate so a typed receive amount can be turned into a
  // fromAmount before the forward quote reconciles it. Re-runs whenever the
  // token pair changes. Mirrors SellForm's displayRate effect (lighter: no
  // retry/giveup scaffolding — a stale reference just makes the first inverse
  // estimate slightly off, then the forward re-quote corrects it).
  useEffect(() => {
    if (fromToken === toToken) {
      setDisplayRateValue(null);
      setLoadingDisplayRate(false);
      return;
    }
    let cancelled = false;
    setLoadingDisplayRate(true);
    const run = async () => {
      const res =
        fromToken === "PLAT" || toToken === "PLAT"
          ? await getConvertQuoteAction(fromToken, toToken, "1")
          : await getSwapQuoteAction(fromToken, toToken, "1");
      if (cancelled) return;
      if (res.success) {
        const rate = parseFloat(String(res.quote.rate));
        setDisplayRateValue(Number.isFinite(rate) && rate > 0 ? rate : null);
      } else {
        setDisplayRateValue(null);
      }
      setLoadingDisplayRate(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [fromToken, toToken]);

  // Feed the right-rail exchange-rate card (token→token). Prefer the live
  // quote's rate; fall back to the reference rate before the user types.
  // Mirrors Buy/Sell's onSidebarChange wiring.
  const sidebarRate =
    quote && Number.isFinite(quote.rate) ? quote.rate : displayRateValue;
  const sidebarRateLoading =
    (loadingQuote && enteredFrom > 0) ||
    (loadingDisplayRate && sidebarRate == null);

  useEffect(() => {
    onSidebarChange?.({
      token: fromToken,
      quoteToken: toToken,
      fiatCurrency: "USD",
      rate: sidebarRate,
      loadingRate: sidebarRateLoading,
    });
  }, [onSidebarChange, fromToken, toToken, sidebarRate, sidebarRateLoading]);

  // Forward (from-driven) quote: user typed in "From", we quote and write the
  // result into the editable "To" field. Bails when the To side is the active
  // editor so we never overwrite their typed target.
  useEffect(() => {
    if (lastEditedField !== "from") return;
    // Invalidate the prior quote synchronously on every input change.
    // It was priced for the previous fromAmount/fromToken/toToken and
    // must not gate the chip or submit button until the fresh debounced
    // quote lands. Without this, the daily-cap check (which derives
    // from `quote.fromUSDValue`) would briefly evaluate against the
    // stale value when the user types a larger amount, letting them
    // click submit against an over-cap input before the new quote
    // arrives. Server re-validates, but the client gate must hold.
    setQuote(null);

    // When MAX is active — or the typed amount is within rounding distance
    // of the full balance — quote against the full-precision raw balance so
    // the receive amount matches what the server will actually deliver.
    const submitAmount = overByRounding
      ? rawFromBalance
      : exactFromAmount ?? fromAmount;

    let cancelled = false;
    const timer = setTimeout(async () => {
      const v = parseFloat(submitAmount);
      if (!Number.isFinite(v) || v <= 0 || fromToken === toToken) {
        setQuote(null);
        setToAmount("");
        return;
      }
      setLoadingQuote(true);

      if (involvesPlat) {
        // AMM-involving Convert: hit the new convert quote endpoint.
        const res = await getConvertQuoteAction(
          fromToken,
          toToken,
          submitAmount
        );
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          const q = res.quote;
          setQuote({
            fromToken,
            toToken,
            fromAmount: submitAmount,
            toAmount: q.toAmount,
            rate: q.rate,
            fromUSDValue: q.fromUSDValue,
            involvesAmm: true,
            priceImpactBps: q.priceImpactBps,
          });
          // Mirror the computed receive amount into the editable To field
          // so the from-driven direction stays in sync.
          setToAmount(formatFixed2(parseFloat(q.toAmount)));
        } else {
          setQuote(null);
        }
      } else {
        // Stable ↔ stable: the existing ledger-swap quote. Shape doesn't
        // include `fromUSDValue` directly, so we derive it from
        // `fromUSDRate` (which it does include).
        const res = await getSwapQuoteAction(fromToken, toToken, submitAmount);
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          const q = res.quote as unknown as SwapQuoteShape;
          const usdRate = q.fromUSDRate ?? 1;
          setQuote({
            fromToken,
            toToken,
            fromAmount: submitAmount,
            toAmount: q.toAmount,
            rate: q.rate,
            fromUSDValue: parseFloat(q.fromAmount) * usdRate,
            involvesAmm: false,
            priceImpactBps: null,
          });
          setToAmount(formatFixed2(parseFloat(q.toAmount)));
        } else {
          setQuote(null);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fromToken, toToken, fromAmount, exactFromAmount, involvesPlat, lastEditedField, overByRounding, rawFromBalance]);

  // Inverse (to-driven) quote: user typed in "To", we estimate the fromAmount
  // needed from the reference rate, set "From" to that estimate, and forward-
  // quote it. The user's typed receive value stays sticky. Mirrors SellForm's
  // receive-driven effect (no fee buffer — Convert has no separate fee leg).
  useEffect(() => {
    if (lastEditedField !== "to") return;
    setQuote(null);

    let cancelled = false;
    const timer = setTimeout(async () => {
      const targetTo = parseFloat(toAmount);
      if (!Number.isFinite(targetTo) || targetTo <= 0 || fromToken === toToken) {
        setQuote(null);
        setFromAmount("");
        setExactFromAmount(null);
        setLoadingQuote(false);
        return;
      }
      if (displayRateValue == null || displayRateValue <= 0) {
        // Reference rate not loaded yet — wait; this effect re-fires once
        // displayRateValue populates.
        return;
      }
      // rate is toTokens per 1 fromToken, so fromAmount ≈ targetTo / rate.
      // The forward re-quote reconciles AMM price-impact drift.
      const fromForQuote = (targetTo / displayRateValue).toFixed(2);
      // Reflect the estimate in fromAmount immediately so the balance /
      // minimum / daily-cap checks evaluate against it even if the quote API
      // rejects the amount. A derived amount is never a MAX drain.
      setFromAmount(fromForQuote);
      setExactFromAmount(null);

      setLoadingQuote(true);
      // Branch the await like the forward effect does so each `res` narrows
      // to its concrete quote shape (a single union `res` won't narrow on a
      // boolean flag).
      if (involvesPlat) {
        const res = await getConvertQuoteAction(fromToken, toToken, fromForQuote);
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          const q = res.quote;
          setQuote({
            fromToken,
            toToken,
            fromAmount: fromForQuote,
            toAmount: q.toAmount,
            rate: q.rate,
            fromUSDValue: q.fromUSDValue,
            involvesAmm: true,
            priceImpactBps: q.priceImpactBps,
          });
        } else {
          setQuote(null);
        }
      } else {
        const res = await getSwapQuoteAction(fromToken, toToken, fromForQuote);
        if (cancelled) return;
        setLoadingQuote(false);
        if (res.success) {
          const q = res.quote as unknown as SwapQuoteShape;
          const usdRate = q.fromUSDRate ?? 1;
          setQuote({
            fromToken,
            toToken,
            fromAmount: fromForQuote,
            toAmount: q.toAmount,
            rate: q.rate,
            fromUSDValue: parseFloat(q.fromAmount) * usdRate,
            involvesAmm: false,
            priceImpactBps: null,
          });
        } else {
          setQuote(null);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [toAmount, lastEditedField, fromToken, toToken, displayRateValue]);

  const flipTokens = () => {
    setFromToken(toToken);
    setToToken(fromToken);
    setFromAmount("");
    setToAmount("");
    setExactFromAmount(null);
    setQuote(null);
    // Reset to the canonical from-driven direction after a flip so the
    // emptied fields don't get reinterpreted as a typed receive target.
    setLastEditedField("from");
  };

  const handleConvert = async () => {
    // Defensive: `convertInsufficient` / `belowMinConvert` /
    // `exceedsDailyCap` already disable the button — these guards just
    // keep the action safe if a race ever lets a click through.
    if (!quote || convertInsufficient || belowMinConvert || exceedsDailyCap)
      return;
    setSubmitting(true);

    // Use the exact full-precision balance when MAX is active — or when the
    // typed amount is within rounding distance of the full balance — so the
    // server receives an amount the wallet can actually cover; otherwise the
    // (already-2-decimal-capped) input value.
    const submitAmount = overByRounding
      ? rawFromBalance
      : exactFromAmount ?? fromAmount;

    // Show the persistent in-flight banner for every convert path
    // (AMM and stable↔stable) so the UX feedback feels consistent with
    // Buy / Sell. Stable↔stable runs sub-second so the banner is a
    // brief flash — accepted as the cost of a uniform pattern across
    // all three boxes. try/finally guarantees we always clear it and
    // `submitting` so the form doesn't get stuck if anything throws.
    setActiveConvert({
      fromToken,
      toToken,
      fromAmount: submitAmount,
      toAmount: quote.toAmount,
    });

    try {
      // Branch the execute path the same way the quote does. Both
      // actions share the same Pending-admin-approval handling so the
      // user-facing toast for either path is identical.
      const res = involvesPlat
        ? await executeConvertAction(fromToken, toToken, submitAmount)
        : await executeSwapAction(fromToken, toToken, submitAmount);
      if (!res.success) {
        if (res.requiresApproval) {
          pushToast({
            variant: "warning",
            title: "Review required",
            description:
              "This conversion is over the limit for instant processing — it's now waiting for a quick review by our team.",
          });
        } else {
          pushToast({
            variant: "error",
            title: "Conversion failed",
            description: res.error,
          });
        }
        return;
      }
      // Build the success description from the quote we showed the user.
      // For the new convert action the ProcessResult doesn't carry
      // from/to amounts separately, but we already have the exact numbers
      // the user clicked on in `quote`.
      pushToast({
        variant: "success",
        title: "Conversion complete",
        description: `Converted ${formatFixed2(
          parseFloat(quote.fromAmount)
        )} ${fromToken} → ${formatFixed2(
          parseFloat(quote.toAmount)
        )} ${toToken}`,
      });
      setFromAmount("");
      setToAmount("");
      setExactFromAmount(null);
      setQuote(null);
      setLastEditedField("from");
      setReviewOpen(false);
      void onComplete();
    } finally {
      setSubmitting(false);
      setActiveConvert(null);
    }
  };

  return (
    <FormCard>
      <FormTitle
        title="Convert between PLAT Tokens"
        subtitle="Instantly swap between your PLAT Tokens at the current market rate."
      />

      <div className="relative mt-9 space-y-3">
        <FieldShell
          label="Convert From"
          bodyCentered
          sideText={
            <span className="font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
              Current balance:{" "}
              {loading ? (
                <span
                  aria-hidden
                  className="inline-block h-[12px] w-[80px] rounded bg-[#E5E7EB] animate-pulse align-middle"
                />
              ) : (
                <>
                  <span className="font-semibold text-[#6B7280]">
                    {formatBalance(fromBalance)} {fromToken}
                  </span>{" "}
                  <span className="font-semibold text-[#6B7280]">·</span>{" "}
                  <button
                    type="button"
                    onClick={() => {
                      // MAX always drives the from-side direction.
                      setLastEditedField("from");
                      // Same MAX-fill strategy as SellForm — see
                      // `floorToCents` for the rationale.
                      const floored = floorToCents(fromBalance);
                      if (floored < DUST_BALANCE) {
                        // Dust-only / empty balance: no-op so the CTA
                        // stays disabled. See SellForm's MAX for the
                        // sub-cent-precision rationale.
                        setFromAmount("0.00");
                        setExactFromAmount(null);
                        return;
                      }
                      setFromAmount(floored.toFixed(2));
                      setExactFromAmount(rawFromBalance);
                    }}
                    className="font-sans text-[12px] font-semibold leading-[18px] text-[#0284C7] underline underline-offset-2 hover:text-[#3EB7ED]"
                  >
                    MAX
                  </button>
                </>
              )}
            </span>
          }
        >
          <NumberInput
            value={fromAmount}
            onChange={(v) => {
              setFromAmount(v);
              setExactFromAmount(null);
              setLastEditedField("from");
            }}
            placeholder="0.00"
            maxDecimals={2}
            suffix={fromToken}
            showSuffixWhenEmpty
            align="left"
          />
          <TokenDropdown
            value={fromToken}
            options={CONVERT_TOKENS}
            header="PLAT Token to Convert"
            bare
            onChange={(v) => {
              setFromToken(v as TokenSymbol);
              // Different token = different balance, so any MAX-captured
              // exact amount is now stale.
              setExactFromAmount(null);
              // If the user was driving from this side, the receive estimate
              // is now stale for the new pair; the forward effect repopulates.
              if (lastEditedField === "from") setToAmount("");
            }}
          />
        </FieldShell>

        <button
          type="button"
          onClick={flipTokens}
          aria-label="Flip tokens"
          className="absolute left-1/2 top-1/2 z-10 flex h-[36px] w-[36px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#E5E7EB] bg-white shadow-sm transition-colors hover:bg-[#F9FAFB]"
        >
          <img
            src="/icons/exchange-swap-vertical.svg"
            alt=""
            className="h-[14px] w-[14px] object-contain"
          />
        </button>

        <FieldShell
          variant="input"
          label="Convert To"
          bodyCentered
          sideText={
            <span className="font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
              Current balance:{" "}
              {loading ? (
                <span
                  aria-hidden
                  className="inline-block h-[12px] w-[80px] rounded bg-[#E5E7EB] animate-pulse align-middle"
                />
              ) : (
                <span className="font-semibold text-[#6B7280]">
                  {formatBalance(toBalance)} {toToken}
                </span>
              )}
            </span>
          }
        >
          <NumberInput
            // Bidirectional: while the to-side is the active editor we keep
            // the user's typed value sticky; while the from-side drives we
            // show the forward-quote result.
            value={toAmount}
            onChange={(v) => {
              setToAmount(v);
              setLastEditedField("to");
            }}
            placeholder={loadingQuote ? "…" : "0.00"}
            maxDecimals={2}
            suffix={toToken}
            showSuffixWhenEmpty
            align="left"
          />
          <TokenDropdown
            value={toToken}
            // Show all five tokens regardless of what From is — filtering
            // caused icon bugs when the value briefly fell outside the
            // options. Same-token case is handled via the yellow warning
            // chip + disabled button below.
            options={CONVERT_TOKENS}
            header="Receive in PLAT Tokens"
            bare
            onChange={(v) => {
              setToToken(v as TokenSymbol);
              // A typed receive target is denominated in the old token, so
              // it's stale once the receive token changes.
              if (lastEditedField === "to") setToAmount("");
            }}
          />
        </FieldShell>
      </div>

    <div className="mt-6">
      <StatusChip
        className="mb-6"
        {...((): ChipState => {
          if (sameTokens) {
            return {
              variant: "warning",
              message: "Pick two different tokens to convert between.",
            };
          }
          const hasFromInput =
            !!fromAmount && parseFloat(fromAmount) > 0;
          if (!hasFromInput) {
            return {
              variant: "info",
              message: "Please enter an amount to convert.",
            };
          }
          if (convertInsufficient) {
            return {
              variant: "warning",
              message:
                fromBalance <= 0
                  ? `You don't have any ${fromToken} available to convert.`
                  : `You only have ${formatBalance(
                      fromBalance
                    )} ${fromToken} available to convert.`,
            };
          }
          if (belowMinConvert) {
            return {
              variant: "warning",
              message: `Minimum conversion is ${MIN_CONVERT_AMOUNT.toFixed(
                2
              )} ${fromToken}.`,
            };
          }
          if (exceedsDailyCap) {
            return {
              variant: "warning",
              message: `This conversion exceeds your daily limit of ${formatUsd(
                dailyCap
              )}.`,
            };
          }
          // Quote hasn't arrived yet (350 ms debounce + network). Avoid
          // flashing the green "Ready" chip — the submit button stays
          // disabled by `!quote`, and the daily-cap warning above also
          // depends on quote data; without this guard the chip would
          // fall straight through to "ready" against an unknown state.
          if (!quote) {
            return {
              variant: "info",
              message: "Calculating quote…",
            };
          }
          return {
            variant: "ready",
            message:
              "Ready — your tokens convert instantly when you click Convert.",
          };
        })()}
      />

      <div>
      <PrimaryButton
        label="Review Conversion"
        loading={submitting}
        disabled={
          !fromAmount ||
          parseFloat(fromAmount) <= 0 ||
          !quote ||
          submitting ||
          sameTokens ||
          convertInsufficient ||
          belowMinConvert ||
          exceedsDailyCap
        }
        onClick={() => setReviewOpen(true)}
      /></div>

      <div className="!mt-4 -mb-1 sm:-mb-2 lg:-mb-3">
        <Fineprint text="Conversions over $5,000 — or any conversion that pushes your daily total past $5,000 — need a quick review by our team." />
      </div>
    </div>

    {reviewOpen && quote && (
      <ConvertReviewModal
        fromToken={fromToken}
        toToken={toToken}
        convertAmount={`${formatFixed2(parseFloat(quote.fromAmount))} ${fromToken}`}
        exchangeRate={`1 ${fromToken} = ${formatFixed2(quote.rate)} ${toToken}`}
        priceEffect={
          // Only surface the price-effect row when the impact is material
          // (≥500 bps = 5%), matching the Buy "Purchase Details" and Sell
          // "Sale Details" modals. Below that it's noise.
          involvesPlat && (quote.priceImpactBps ?? 0) >= 500 ? (
            <PriceImpactValue
              bps={quote.involvesAmm ? quote.priceImpactBps ?? 0 : null}
              direction={
                quote.involvesAmm
                  ? toToken === "PLAT"
                    ? "up"
                    : "down"
                  : null
              }
            />
          ) : null
        }
        receiveAmount={`${formatFixed2(parseFloat(quote.toAmount))} ${toToken}`}
        loading={submitting}
        onClose={() => setReviewOpen(false)}
        onConfirm={handleConvert}
      />
    )}
    </FormCard>
  );
}

interface SwapQuoteShape {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  rate: number;
  fromUSDRate?: number;
  toUSDRate?: number;
  processingFeeBps?: number;
  processingFeeUsd?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Form atoms
// ─────────────────────────────────────────────────────────────────────

// Status chip rendered between the summary and the action button on
// each form. Three variants — info (blue, "tell me more"), warning
// (amber, blocks submit), ready (green, valid + a heads-up about the
// next step). Always rendered so swapping states never shifts the
// surrounding layout; `min-h` reserves height for two lines of copy.
function StatusChip({
  variant,
  message,
  className = "mt-4",
}: {
  variant: "info" | "warning" | "ready";
  message: React.ReactNode;
  className?: string;
}) {
  const palette =
    variant === "info"
      ? "border-sky-200 bg-sky-50 text-sky-800"
      : variant === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-emerald-200 bg-emerald-50 text-emerald-800";
  return (
    <div
      className={`${className} flex min-h-[40px] items-center rounded-md border px-3 py-2 text-sm ${palette}`}
    >
      {message}
    </div>
  );
}

type ChipState = {
  variant: "info" | "warning" | "ready";
  message: React.ReactNode;
};

function FormCard({ children }: { children: React.ReactNode }) {
  // `h-full` + flex-col lets the form card stretch to match the right
  // rail's height in the grid row. Forms then use `mt-auto` on their
  // action footer (chip + button + fineprint) to pin it to the bottom
  // so the card's bottom edge aligns with the activity card.
  return (
    <div className="ex-card flex h-full w-full max-w-full min-w-0 flex-col overflow-hidden px-4 py-5 sm:px-8 sm:pt-7 sm:pb-9 lg:px-10 lg:pt-7 lg:pb-10">
      {children}
    </div>
  );
}

// Titles use Work Sans and supporting copy uses Inter across form cards.
function FormTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mt-4">
      <h2 className="font-display text-[20px] sm:text-[22px] md:text-[24px] lg:text-[28px] font-semibold leading-[24px] text-[#111827]">
        {title}
      </h2>
      <p className="font-sans mt-3 text-[13px] sm:text-[14px] md:text-[15px] lg:text-[16px] font-normal leading-none text-[#6B7280]">
        {subtitle}
      </p>
    </div>
  );
}

function FieldShell({
  label,
  sideText,
  children,
  variant = "input",
  centerContent = false,
  hideLabel = false,
  reverseContent = false,
  bodyCentered = false,
}: {
  label: string;
  sideText?: React.ReactNode;
  children: React.ReactNode;
  /**
   * "input" → white background, signals the editable / active field.
   * "output" → muted gray background, signals a computed read-only result.
   * Top field is always "input", bottom is always "output" across Buy /
   * Sell / Convert.
   */
  variant?: "input" | "output";
  /**
   * When true, only the children row renders inside the card and
   * vertically centres there. The question is rendered outside by the
   * Buy form so the field body stays visually balanced.
   */
  centerContent?: boolean;
  /** Keeps the top metadata row, but omits the left label text. */
  hideLabel?: boolean;
  /** Reverses visual row order while preserving DOM order. */
  reverseContent?: boolean;
  /**
   * Adds a small top margin to the children row, nudging the dropdown +
   * amount down toward the card's center without disturbing the label's
   * top position. Only affects the non-`centerContent` layout.
   */
  bodyCentered?: boolean;
}) {
  const surfaceClass =
    variant === "input"
      ? "bg-white border border-[var(--ex-border)]"
      : "bg-[var(--ex-surface-muted)] border border-[var(--ex-border)]";
  return (
    <div
      className={
        centerContent
          ? `relative rounded-xl ${surfaceClass} min-h-[92px] px-3 sm:min-h-[104px] sm:px-5`
          : `rounded-xl ${surfaceClass} px-3 py-4 sm:px-5 sm:py-5 min-h-[92px] sm:min-h-[104px]`
      }
    >
      {!centerContent && (
        <div
          className={
            hideLabel
              ? "mb-2 flex justify-end"
              : "mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
          }
        >
          {!hideLabel && (
            <span className="font-sans text-[13px] font-semibold leading-[18px] text-[#6B7280]">
              {label}
            </span>
          )}
          {sideText && (
            <span className="font-sans text-[12px] font-normal leading-[18px] text-[#6B7280] text-right">
              {sideText}
            </span>
          )}
        </div>
      )}
      <div
        className={
          centerContent
            ? "flex min-h-[92px] min-w-0 items-center gap-2 sm:min-h-[104px] sm:gap-3"
            : `flex min-w-0 items-center gap-2 sm:gap-3 ${
                bodyCentered ? "mt-2 sm:mt-2 " : ""
              }${reverseContent ? "flex-row-reverse" : ""}`
        }
      >
        {children}
        {sideText && centerContent && (
          <span className="ml-auto min-w-0 text-right font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
            {sideText}
          </span>
        )}
      </div>
    </div>
  );
}

// Global cap for all Exchange amount inputs. Anything larger gets
// auto-clamped — purely a UX guard to keep estimated-output fields
// from rendering absurd numbers when someone fat-fingers extra zeros
// or pastes from another tool. The actual per-form constraints
// (balance, Transak min/max, daily cap, etc.) handle the realistic
// upper bounds via their existing yellow warning chips.
const MAX_INPUT_AMOUNT = 1_000_000_000;

// Minimum amount accepted for a stablecoin↔stablecoin convert. All
// four supported PLAT stablecoins are roughly a $1 peg, so 5 of any
// token also means ~$5 minimum value regardless of direction.
const MIN_CONVERT_AMOUNT = 5;

function NumberInput({
  value,
  onChange,
  placeholder,
  readOnly,
  maxDecimals,
  prefix,
  suffix,
  showSuffixWhenEmpty = false,
  align = "left",
  grow = true,
  className = "",
  style,
}: {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  maxDecimals?: number;
  /** Static text rendered before the value (e.g. currency symbol "$"). */
  prefix?: string;
  /** Static text rendered after the value (e.g. token name "PLAT"). */
  suffix?: string;
  /** When true, keep the suffix visible while the placeholder is showing. */
  showSuffixWhenEmpty?: boolean;
  /**
   * Extra classes merged onto the field's root row. Used by the Buy form
   * to apply a visual-only vertical nudge (negative translate-y) so the
   * value drifts up toward the question without moving its sibling
   * dropdown, which lives in the same flex row.
   */
  className?: string;
  /** Inline styles merged onto the field's root row. */
  style?: React.CSSProperties;
  /**
   * Horizontal alignment of the value within its container. "left" (default)
   * is the historical layout used by Sell / Convert. "right" anchors the
   * value to the trailing edge.
   */
  align?: "left" | "right";
  /**
   * When true (default) the outer wrapper uses `flex-1` and the input fills
   * remaining row space — historical Sell / Convert layout. When false the
   * wrapper sizes to content so the input sits flush next to a sibling
   * (e.g. the Buy form's Q&A layout where the dropdown and amount cluster
   * on the left and a balance line sits on the far right).
   */
  grow?: boolean;
}) {
  // Role: Display — the typed amount is the single largest element in the
  // action panel (36px desktop), so the eye lands on it the moment a form
  // opens. Sits one full step above every heading on the page.
  const valueClass =
    "text-[24px] sm:text-[28px] font-display font-semibold leading-none text-[var(--ex-text)]";
  // Adornments are lighter than the value so the typed number stays the
  // emphasis. The two adornments are sized differently on purpose:
  //   • prefix (the currency symbol "$", "€") sits closer to the value's
  //     size so it reads as part of the amount.
  //   • suffix (the unit "PLAT", "USD") is smaller — it's a label, not
  //     part of the number.
  const prefixClass =
    "shrink-0 font-display font-normal leading-none text-[var(--ex-text-muted)] text-[18px] sm:text-2xl lg:text-[28px]";
  const suffixClass =
    "shrink-0 font-display font-normal leading-none text-[var(--ex-text-muted)] text-[13px] sm:text-base lg:text-[16px]";

  // Read-only with a suffix: render the value as static text so the
  // suffix sits flush to the right of the number ("130.67 PLAT").
  // Using an <input flex-1> here would push the suffix to the far edge
  // of the field shell, breaking the unit-attached look.
  if (readOnly) {
    const hasValue = value !== "";
    return (
      <div
        className={`flex min-w-0 max-w-full items-baseline gap-1.5 cursor-default select-none ${
          grow ? "flex-1" : ""
        } ${align === "right" ? "justify-end" : ""} ${className}`}
      >
        {prefix && <span className={prefixClass}>{prefix}</span>}
        <span
          className={`${valueClass} min-w-0 truncate ${
            hasValue ? "" : "text-[var(--ex-text-subtle)]"
          }`}
        >
          {hasValue ? value : placeholder ?? ""}
        </span>
        {suffix && (hasValue || showSuffixWhenEmpty) && (
          <span className={suffixClass}>{suffix}</span>
        )}
      </div>
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!onChange) return;

    const raw = e.target.value.replace(/[^\d.]/g, "");
    const parts = raw.split(".");
    const whole = parts[0] ?? "";

    let sanitized =
      parts.length > 2 ? `${whole}.${parts.slice(1).join("")}` : raw;

    if (
      typeof maxDecimals === "number" &&
      maxDecimals >= 0 &&
      sanitized.includes(".")
    ) {
      const [integerPart, decimalPart = ""] = sanitized.split(".");
      sanitized = `${integerPart}.${decimalPart.slice(0, maxDecimals)}`;
    }

    // Normalize leading zeros on the integer part so "010" → "10"
    // and a long zero string ("00000…0") collapses to "0". Keeps
    // "0" when the integer is empty/all-zeros so "0.5" stays "0.5"
    // and a bare "0" remains valid while typing. Also normalizes
    // ".5" → "0.5".
    if (sanitized !== "") {
      const [intPart, ...restParts] = sanitized.split(".");
      const hadDecimal = restParts.length > 0;
      const normalizedInt = intPart.replace(/^0+/, "") || "0";
      sanitized = hadDecimal
        ? `${normalizedInt}.${restParts.join("")}`
        : normalizedInt;
    }

    // Global cap — snap anything over MAX_INPUT_AMOUNT down to it.
    // Matches the Stake input's total-supply clamp on the Staking
    // page, just with a generic 1B ceiling for the Exchange.
    const n = parseFloat(sanitized);
    if (Number.isFinite(n) && n > MAX_INPUT_AMOUNT) {
      onChange(String(MAX_INPUT_AMOUNT));
      return;
    }

    onChange(sanitized);
  };

  const inputRef = useRef<HTMLInputElement>(null);
  const inputClassBase =
    "min-w-0 max-w-full bg-transparent text-[24px] sm:text-[28px] font-display font-semibold leading-none text-[var(--ex-text)] focus:outline-none placeholder:text-[var(--ex-text-subtle)] p-0 m-0 border-0";
  // When align=right the input itself stays anchored to the trailing edge
  // via parent `justify-end`. Adding `text-right` keeps the typed value
  // visually right-flush as it grows (matters most when there's no suffix
  // to size the input via `field-sizing: content`).
  const alignTextClass = align === "right" ? "text-right" : "";

  const showSuffix = !!suffix && (value !== "" || showSuffixWhenEmpty);

  return (
    <div
      className={`flex min-w-0 max-w-full items-baseline gap-1.5 cursor-text ${
        grow ? "flex-1" : ""
      } ${align === "right" ? "justify-end" : ""} ${className}`}
      style={style}
      onClick={() => inputRef.current?.focus()}
    >
      {prefix && <span className={prefixClass}>{prefix}</span>}
      {/* Single stable <input> across all states so React doesn't
          unmount it (focus survives the first keystroke).
          When a suffix is attached, `field-sizing: content` sizes the
          input to its actual rendered text width — exact, not the
          `size` attribute's avg-char-width approximation that left a
          visible gap for narrow chars like "1". The `size` attribute is
          kept only as the empty-state fallback so the placeholder
          renders at its full width before the user types. */}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        size={
          !suffix
            ? undefined
            : value !== ""
            ? 1
            : Math.max(placeholder?.length ?? 4, 4)
        }
        className={
          suffix
            ? `${inputClassBase} ${alignTextClass} [field-sizing:content]`
            : `${inputClassBase} ${alignTextClass} flex-1 truncate`
        }
      />
      {showSuffix && <span className={suffixClass}>{suffix}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Custom icon dropdown — replaces native `<select>` so option rows can
// render the brand SVG icon next to each label (matches the Figma
// "Context Menu" spec). Native <select> renders its options panel with
// OS-level styling that ignores CSS.
//
// Behavior:
//   • Click trigger → toggles the popover.
//   • Click outside or press Esc → closes (effect attaches listeners
//     only while open).
//   • Selecting an option fires `onChange` and closes the popover.
//   • Disabled state: button can't be clicked, popover stays shut.
// ─────────────────────────────────────────────────────────────────────

interface IconDropdownOption<T extends string> {
  value: T;
  /** Row label shown inside the popover. Free to be long-form
   *  ("U.S. Dollar ($)") since the popover has room. */
  label: string;
  /** Optional override used on the trigger button only. Lets callers
   *  show a short code in the field shell ("USD") while the popover row
   *  carries the verbose name. Falls back to `label` if not set. */
  triggerLabel?: string;
  iconSrc: string;
}

function IconDropdown<T extends string>({
  value,
  options,
  onChange,
  header,
  disabled,
  bare = false,
  style,
}: {
  value: T;
  options: IconDropdownOption<T>[];
  onChange?: (v: T) => void;
  /** Optional small-caps label rendered at the top of the popover.
   *  Used to disambiguate identical-looking dropdowns by context
   *  ("PLAT TOKEN TO BUY" vs "PLAT TOKEN TO SELL" etc.). */
  header?: string;
  disabled?: boolean;
  /** Borderless, larger trigger that relies on a hover-fill instead of a
   *  permanent box — avoids the "double-box" when nested in a FieldShell.
   *  Only the trigger changes; the popover is unaffected. */
  bare?: boolean;
  /** Inline styles merged onto the root container. Used by the Exchange
   *  forms to apply a visual-only vertical nudge so the trigger aligns
   *  with the question above it. The popover anchors to this same
   *  container, so it follows the nudge and stays attached. */
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0" style={style}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          bare
            ? "flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[16px] font-medium text-[var(--ex-text)] hover:bg-[#EEF1F5] focus:outline-none focus:ring-2 focus:ring-[var(--ex-accent)]/20 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer transition-colors"
            : "flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg bg-white border border-[var(--ex-border)] text-sm font-medium text-[var(--ex-text)] hover:border-[var(--ex-border-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--ex-accent)]/20 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer transition-colors"
        }
      >
        {selected && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={selected.iconSrc}
            alt=""
            className={
              bare
                ? "h-6 w-6 rounded-full object-contain shrink-0"
                : "h-5 w-5 rounded-full object-contain shrink-0"
            }
          />
        )}
        <span>{selected?.triggerLabel ?? selected?.label ?? value}</span>
        <ChevronDown
          className={`${bare ? "w-4 h-4" : "w-3.5 h-3.5"} text-[var(--ex-text-muted)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-30 right-0 mt-1 min-w-[200px] rounded-lg border border-[var(--ex-border)] bg-white shadow-lg py-1"
        >
          {header && (
            <div className="px-4 pt-2 pb-1.5 font-sans text-[10px] uppercase tracking-[0.08em] font-semibold text-[#9CA3AF]">
              {header}
            </div>
          )}
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  if (o.value !== value) onChange?.(o.value);
                  setOpen(false);
                }}
                className={
                  active
                    ? "w-full flex items-center gap-3 px-4 py-2 text-sm font-medium text-[var(--ex-text)] bg-[var(--ex-surface-muted)] cursor-pointer"
                    : "w-full flex items-center gap-3 px-4 py-2 text-sm font-medium text-[var(--ex-text)] hover:bg-[var(--ex-surface-muted)] cursor-pointer transition-colors"
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={o.iconSrc}
                  alt=""
                  className="h-5 w-5 rounded-full object-contain shrink-0"
                />
                <span>{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CurrencyDropdown({
  value,
  options,
  onChange,
  header,
  disabled,
  bare = false,
  style,
}: {
  value: FiatCurrency;
  options: readonly FiatCurrency[];
  onChange?: (v: FiatCurrency) => void;
  /** Small-caps context label rendered above the option list — e.g.
   *  "PAY WITH CARD / BANK" in Buy or "RECEIVE IN CARD / BANK" in Sell. */
  header?: string;
  disabled?: boolean;
  /** Borderless, larger trigger — see IconDropdown. */
  bare?: boolean;
  /** Inline styles forwarded to the dropdown container — see IconDropdown. */
  style?: React.CSSProperties;
}) {
  return (
    <IconDropdown<FiatCurrency>
      value={value}
      options={options.map((o) => ({
        value: o,
        // Both popover row AND trigger show the disambiguated long
        // form so the user can never mistake the fiat "USD" for the
        // "USDX" stablecoin token at any point in the interaction —
        // not just while the popover is open.
        label: `${FIAT_FULL_NAMES[o]} (${FIAT_SYMBOLS[o]})`,
        iconSrc: fiatIconSrc(o),
      }))}
      onChange={onChange}
      header={header}
      disabled={disabled}
      bare={bare}
      style={style}
    />
  );
}

function TokenDropdown({
  value,
  options,
  onChange,
  header,
  disabled,
  bare = false,
  style,
}: {
  value: TokenSymbol;
  options: readonly TokenSymbol[];
  onChange?: (v: TokenSymbol) => void;
  /** Small-caps context label rendered above the option list — e.g.
   *  "PLAT TOKEN TO BUY" / "PLAT TOKEN TO SELL" / "PLAT TOKEN TO CONVERT". */
  header?: string;
  disabled?: boolean;
  /** Borderless, larger trigger — see IconDropdown. */
  bare?: boolean;
  /** Inline styles forwarded to the dropdown container — see IconDropdown. */
  style?: React.CSSProperties;
}) {
  return (
    <IconDropdown<TokenSymbol>
      value={value}
      options={options.map((o) => ({
        value: o,
        label: TOKEN_DISPLAY_NAMES[o],
        iconSrc: tokenIconSrc(o),
      }))}
      onChange={onChange}
      header={header}
      disabled={disabled}
      bare={bare}
      style={style}
    />
  );
}


function FixedTokenDisplay({ value }: { value: TokenSymbol }) {
  return (
    <div className="relative shrink-0">
      <div className="flex items-center gap-2 rounded-lg bg-white border border-[var(--ex-border)] pl-3 pr-4 py-2 text-sm font-medium text-[#4B5563]">
        <img
          src={tokenIconSrc(value)}
          alt=""
          className="h-5 w-5 rounded-full object-contain"
        />
        <span>{value}</span>
      </div>
    </div>
  );
}

// Static, non-interactive token label used by the Buy / Sell forms, which
// are locked to PLAT. Mirrors IconDropdown's `bare` trigger styling
// (icon + label, larger sizing) minus the chevron and the open/close
// behaviour, so it sits cleanly inside a FieldShell without the "double
// box" a bordered chip would introduce.
function FixedTokenLabel({ value }: { value: TokenSymbol }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 px-3 py-1.5 text-[16px] font-medium text-[var(--ex-text)]">
      <img
        src={tokenIconSrc(value)}
        alt=""
        className="h-6 w-6 shrink-0 rounded-full object-contain"
      />
      <span>{value}</span>
    </div>
  );
}



function DownConnector() {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
      <div className="flex h-[36px] w-[36px] items-center justify-center rounded-full border border-[#E5E7EB] bg-white shadow-sm">
        <img
          src="/icons/exchange-arrow-down.svg"
          alt=""
          className="h-[12px] w-[12px] object-contain"
        />
      </div>
    </div>
  );
}

function SummaryRows({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--ex-border)] divide-y divide-[var(--ex-border)] bg-white">
      {children}
    </div>
  );
}

/**
 * Small "i in a circle" info button. Opens its tooltip on hover (desktop)
 * AND on click/tap (mobile). Pinned-by-click state closes on outside
 * pointer-down or Escape. Keyboard-accessible: tab to focus, focus
 * triggers the tooltip (same as hover), Escape closes a pinned tooltip.
 */
function InfoTooltip({ content }: { content: string }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const open = pinned || hovered;

  // Outside-click + Escape only matter while pinned; hover state
  // self-clears on mouseLeave/blur.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPinned(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="More info"
        aria-expanded={open}
        onClick={() => setPinned((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[#9CA3AF] transition-colors hover:text-[#6B7280] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0EA5E9] focus-visible:ring-offset-1"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="h-full w-full"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-[240px] max-w-[80vw] -translate-x-1/2 rounded-md bg-[#111827] px-3 py-2 text-[11px] font-normal leading-[16px] text-white shadow-lg"
        >
          {content}
        </span>
      )}
    </span>
  );
}

function SummaryRow({
  label,
  value,
  tooltip,
  muted,
}: {
  label: string;
  value: React.ReactNode;
  emphasize?: boolean;
  /**
   * Optional plain-text help. When set, an info icon is rendered next
   * to the label; the icon opens a tooltip on hover (desktop) and on
   * click/tap (mobile). The body remains plain text — no markdown.
   */
  tooltip?: string;
  /**
   * Renders the row in a de-emphasised style for cases where the metric
   * doesn't apply to the current selection (e.g. price-effect-on-PLAT
   * when neither side of the trade is PLAT). Both label and value
   * text shift to a lighter grey. Caller is responsible for passing a
   * value that reads gracefully when muted — typically a plain "—"
   * string rather than a styled component that overrides the colour.
   */
  muted?: boolean;
}) {
  // Two steps lighter than the default `#6B7280` row colour so the row
  // clearly recedes when N/A while staying just legible enough to read.
  // The info icon keeps its own `#9CA3AF` (darker than this muted text)
  // so it stands out as the affordance to "see why this is N/A".
  const textColor = muted ? "text-[#D1D5DB]" : "text-[#6B7280]";
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span
        className={`inline-flex items-center gap-1.5 font-sans text-[12px] font-normal leading-[18px] ${textColor}`}
      >
        <span>{label}</span>
        {tooltip && <InfoTooltip content={tooltip} />}
      </span>
      <span
        className={`font-sans text-[12px] font-normal leading-[18px] ${textColor}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Shared renderer for the "Est. price effect on PLAT" summary row across
 * Buy / Sell / Convert. Severity colours stay anchored to magnitude (green
 * → amber → rose), while the leading sign indicates direction:
 *   • "+" — the trade adds PLAT buying pressure (pool gains USDX,
 *           loses PLAT → spot price moves up).
 *   • "−" — the trade adds PLAT selling pressure (pool gains PLAT,
 *           loses USDX → spot price moves down).
 * Returns a muted "—" when no AMM hop is involved (stable-only sells,
 * stable ↔ stable Convert), so the row stays visually consistent across
 * all three forms regardless of which tokens the user picked.
 */
function PriceImpactValue({
  bps,
  direction,
}: {
  bps: number | null;
  direction: "up" | "down" | null;
}) {
  if (bps == null || direction == null) {
    return (
      <span className="font-sans text-[12px] font-normal leading-[18px] text-[#6B7280]">
        —
      </span>
    );
  }
  const pct = bps / 100;
  let color = "text-[#6B7280]";
  if (bps >= 200) color = "text-rose-600";
  else if (bps >= 50) color = "text-amber-600";
  else if (bps > 0) color = "text-emerald-600";
  const sign = direction === "up" ? "+" : "−";
  // Sub-basis-point impacts collapse to "<0.01" so we don't render a
  // misleading "0.00%" on tiny trades that are still nominally moving
  // the pool. Apply only when there IS impact (bps > 0).
  const display = pct > 0 && pct < 0.01 ? "<0.01" : pct.toFixed(2);
  return (
    <span className={`font-semibold ${color}`}>
      {sign}
      {display}%
    </span>
  );
}

function PrimaryButton({
  label,
  onClick,
  disabled,
  loading,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={
        disabled || loading
          ? "w-full h-[52px] rounded-[6px] bg-[#D8DEE7] text-[#738094] text-[16px] font-semibold cursor-not-allowed transition-colors"
          : "w-full h-[52px] rounded-[6px] bg-[#0EA5E9] hover:bg-[#3EB7ED] text-white text-[16px] font-semibold shadow-sm transition-colors"
      }
    >
      {loading ? "Working…" : label}
    </button>
  );
}

function Fineprint({ text }: { text: string }) {
  return (
    <p className="font-sans text-[12px] font-normal leading-[18px] text-center text-[#6B7280]">
      {text}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Icons (inline so we don't pull in a library)
// ─────────────────────────────────────────────────────────────────────

function ArrowDown() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v10m0 0-4-4m4 4 4-4" />
    </svg>
  );
}
function ArrowUp() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 13V3m0 0L4 7m4-4 4 4" />
    </svg>
  );
}
function SwapArrows() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h9l-2-2M12 11H3l2 2" />
    </svg>
  );
}
function SwapVertical() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 4v8m0 0L3 10m2 2 2-2M11 12V4m0 0L9 6m2-2 2 2" />
    </svg>
  );
}
function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" d="m3 12 4-4 3 3 3-5" />
    </svg>
  );
}
function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m4 6 4 4 4-4" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────

/**
 * Floor `n` to 2 decimal places without exceeding the original value.
 * Used to fill the input's *display* value on MAX clicks (the raw balance
 * string carries on-chain 18-decimal precision and would otherwise dump
 * something like "110.501153070459849914" into the field). The full
 * precision is preserved separately on `exact*Amount` state so the
 * actual submission still drains the wallet to true zero.
 */
function floorToCents(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rounded = Math.round(n * 100) / 100;
  if (rounded <= n) return rounded;
  return Math.max(0, (Math.round(n * 100) - 1) / 100);
}

/**
 * Sub-cent threshold below which a token balance is treated as "effectively
 * zero". The convert form's minimum and Transak's off-ramp floor are both
 * orders of magnitude larger than a cent, so a stranded 0.0059 dust
 * remainder can't be transacted away — for display and zero-balance UX
 * gates, render it as 0.00.
 */
const DUST_BALANCE = 0.01;

/**
 * Token balance formatter — 2-decimal standard with one carve-out:
 *   • Dust (0 < n < 0.01) renders as "0.00" so empty-state UX matches
 *     the user's intent after a drain-the-wallet MAX-and-spend.
 *
 * Sub-cent precision (e.g. 146.5959) is rounded to "146.60" for display
 * — this can briefly exceed the user's actual balance on the form
 * label, but MAX uses the raw balance string under the hood so submit
 * is still exact, and a stranded 146.5959 only arises from partial
 * drains, not the common case.
 */
function formatBalance(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  if (n > 0 && n < DUST_BALANCE) return "0.00";
  // Floor to cents rather than round, so the displayed balance never exceeds
  // what the user can actually act on. Rounding up (e.g. a true 6.139 →
  // "6.14") disagreed with the MAX shortcut, which floors via floorToCents
  // (→ 6.13) to stay within the real balance — making MAX look like it
  // shortchanged the user. floorToCents also absorbs the float noise from
  // on-chain 18-decimal amounts.
  return floorToCents(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatFixed2(n: number): string {
  if (!Number.isFinite(n)) return "0.00";

  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUsd(n: number, opts: { maxFractionDigits?: number } = {}): string {
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: opts.maxFractionDigits ?? 2,
  });
}

// Generic fiat formatter that uses our local FIAT_SYMBOLS map (matches
// the input-field adornment so "$"/"€"/"£"/"R$" stays consistent across
// the page). Intl.NumberFormat with `style: "currency"` would emit
// localized variants (e.g. "US$" or "R$ ") that don't match.
function formatFiat(
  n: number,
  currency: FiatCurrency,
  opts: { maxFractionDigits?: number } = {}
): string {
  const symbol = FIAT_SYMBOLS[currency];
  if (!Number.isFinite(n)) return `${symbol}0.00`;
  return `${symbol}${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: opts.maxFractionDigits ?? 2,
  })}`;
}

function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/**
 * Compact, contextual date formatter for the rail's activity cards.
 * Mirrors `ActivityHistory.tsx`'s tier system so both surfaces read
 * consistently — Today / Yesterday / DD Mon / DD Mon YYYY. Kept local
 * to Exchange (instead of importing) because the rail rendering is
 * deliberately separated from the shared table component.
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

/** Full readable timestamp for the Date tooltip ("02 May 2026, 13:49:23"). */
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
