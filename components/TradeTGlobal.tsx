// components/TradeTGlobal.tsx
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  getBuyQuote,
  getSellQuote,
  createBuyOrderAction,
  createSellOrderAction,
  getMyTradeHistory,
  getMyTGlobalBalance,
  getMyTradeBalances,
  getTradeOrderStatus,
  retryBuyOrderAction,
  cancelBuyOrderAction,
  checkPendingPaymentAction,
  pollActivePaymentAction,
} from "@/app/actions/trade-orders";
import { getPoolData, getTradeKycStatus, type KYCStatus } from "@/app/actions/amm";

type FiatCurrency = "USD" | "BRL" | "GBP" | "EUR";
type TradeMode = "buy" | "sell";

interface TransakFeeInfo {
  totalFee: number;
  feePercent: number;
  netCryptoAmount: number;
  feeBreakdown: { name: string; value: number }[];
}

interface BuyQuoteData {
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  fiatToTusdRate: number;
  tusdAmount: string;
  tglobalAmount: string;
  ammSpotPrice: string;
  ammEffectivePrice: string;
  priceImpactBps: number;
  feeAmount: string;
  maxSlippageBps: number;
  expiresAt: Date | string;
  paymentToken: string;
  userBalance: string;
  fromBalance: string;
  toCharge: string;
  transakFees: TransakFeeInfo | null;
}

interface SellQuoteData {
  tglobalAmount: string;
  tusdAmount: string;
  payoutCurrency: FiatCurrency;
  payoutToken: string;
  payoutAmount: string;
  tusdToPayoutRate: number;
  ammSpotPrice: string;
  ammEffectivePrice: string;
  priceImpactBps: number;
  feeAmount: string;
  maxSlippageBps: number;
  expiresAt: Date | string;
}

interface TradeOrder {
  order_id: string;
  order_type: string;
  status: string;
  fiat_currency: string;
  fiat_amount: string;
  tusd_amount: string;
  tglobal_amount: string;
  executed_price: string | null;
  operator_tx_hash: string | null;
  failure_reason: string | null;
  created_at: string;
}

interface PendingBuyOrder {
  orderId: string;
  widgetUrl: string;
  fiatAmount: number;
  fiatCurrency: string;
}

interface ActiveOrder {
  orderId: string;
  status: string;
  fiatAmount: string;
  fiatCurrency: string;
  createdAt: string;
  tglobalAmount?: string;
  txHash?: string;
  // Latest Transak payment status — populated by background poll /
  // explicit "Check Payment Status" click. Used to advance the step
  // tracker and disable Cancel before our DB transitions to
  // payment_received via the webhook.
  transakStatus?: string | null;
}

const IN_FLIGHT_STATUSES = ["pending_payment", "payment_received", "executing"];

// Transak statuses where the user's payment is mid-processing or already
// completed and they can no longer safely cancel the order. Mirrors
// NON_CANCELLABLE_TRANSAK_STATUSES on the server.
const TRANSAK_PROCESSING_STATUSES = [
  "PROCESSING",
  "PENDING_DELIVERY_FROM_TRANSAK",
  "ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK",
  "COMPLETED",
];

function isTransakProcessing(status?: string | null): boolean {
  return !!status && TRANSAK_PROCESSING_STATUSES.includes(status);
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

const CURRENCIES: { id: FiatCurrency; label: string; symbol: string; flag: string }[] = [
  { id: "USD", label: "US Dollar", symbol: "$", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "GBP", label: "British Pound", symbol: "\u00A3", flag: "\u{1F1EC}\u{1F1E7}" },
  { id: "EUR", label: "Euro", symbol: "\u20AC", flag: "\u{1F1EA}\u{1F1FA}" },
  { id: "BRL", label: "Brazilian Real", symbol: "R$", flag: "\u{1F1E7}\u{1F1F7}" },
];

const FIAT_TO_TOKEN: Record<FiatCurrency, string> = {
  USD: "USDX",
  GBP: "GBPX",
  EUR: "EURX",
  BRL: "BRLX",
};

const STATUS_COLORS: Record<string, string> = {
  pending_payment: "text-amber-400 bg-amber-400/10",
  payment_received: "text-blue-400 bg-blue-400/10",
  executing: "text-cyan-400 bg-cyan-400/10",
  completed: "text-emerald-400 bg-emerald-400/10",
  slippage_fallback: "text-amber-400 bg-amber-400/10",
  price_changed: "text-orange-400 bg-orange-400/10",
  insufficient_balance: "text-orange-400 bg-orange-400/10",
  failed: "text-red-400 bg-red-400/10",
  cancelled: "text-slate-400 bg-slate-400/10",
};

function formatNumber(value: string | number, decimals = 2): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "0.00";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export default function TradeTGlobal() {
  const [mode, setMode] = useState<TradeMode>("buy");
  const [currency, setCurrency] = useState<FiatCurrency>("USD");
  const [payoutCurrency, setPayoutCurrency] = useState<FiatCurrency>("USD");
  const [amount, setAmount] = useState("");

  // Buy state
  const [buyQuote, setBuyQuote] = useState<BuyQuoteData | null>(null);
  // Sell state
  const [sellQuote, setSellQuote] = useState<SellQuoteData | null>(null);

  const [quoteLoading, setQuoteLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    message: string;
    txHash?: string;
  } | null>(null);

  const [tglobalBalance, setTglobalBalance] = useState("0");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [spotPrice, setSpotPrice] = useState<string | null>(null);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [kyc, setKyc] = useState<KYCStatus | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Transak payment flow (modal lifecycle only)
  const [pendingBuy, setPendingBuy] = useState<PendingBuyOrder | null>(null);

  // Persistent active order tracker (survives modal close / page reload)
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null);
  const activeOrderPollRef = useRef<NodeJS.Timeout | null>(null);

  // Client-generated idempotency key for the current buy intent. Generated
  // lazily on the first submit attempt and re-used for any retry of the same
  // intent (network blip, transient DB error) so we never create duplicate
  // orders. Cleared once the server returns a terminal outcome.
  const buyIdempotencyKeyRef = useRef<string | null>(null);
  const clearBuyIdempotencyKey = useCallback(() => {
    buyIdempotencyKeyRef.current = null;
  }, []);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [paymentCheckResult, setPaymentCheckResult] = useState<string | null>(null);

  // Retry flow for price_changed / insufficient_balance orders
  const [retryableOrder, setRetryableOrder] = useState<{
    orderId: string;
    status: string;
    message: string;
  } | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const [toastBanner, setToastBanner] = useState<{
    message: string;
    variant: "error" | "success";
  } | null>(null);

  const quoteTimeout = useRef<NodeJS.Timeout | null>(null);
  const currencyInfo = CURRENCIES.find((c) => c.id === currency)!;

  const activeOrderRef = useRef<ActiveOrder | null>(null);
  activeOrderRef.current = activeOrder;

  useEffect(() => {
    if (!error) return;
    setToastBanner({ message: error, variant: "error" });
    const t = setTimeout(() => setToastBanner(null), 10_000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (!success) return;
    setToastBanner({ message: success.message, variant: "success" });
    const t = setTimeout(() => setToastBanner(null), 8000);
    return () => clearTimeout(t);
  }, [success]);

  const loadData = useCallback(async () => {
    const [balRes, poolRes, histRes, tradeBalRes, kycRes] = await Promise.all([
      getMyTGlobalBalance(),
      getPoolData(),
      getMyTradeHistory(20, 0),
      getMyTradeBalances(),
      getTradeKycStatus(),
    ]);
    if (balRes.success) setTglobalBalance(balRes.data);
    if (kycRes.success) setKyc(kycRes.data);
    if (poolRes.success) setSpotPrice(poolRes.data.spotPrice);
    if (histRes.success) {
      const fetchedOrders = histRes.data as TradeOrder[];
      setOrders(fetchedOrders);

      // Auto-recover in-flight orders on page load / refresh
      if (!activeOrderRef.current) {
        const inFlight = fetchedOrders.find(
          (o) => o.order_type === "buy" && IN_FLIGHT_STATUSES.includes(o.status)
        );
        if (inFlight) {
          setActiveOrder({
            orderId: inFlight.order_id,
            status: inFlight.status,
            fiatAmount: inFlight.fiat_amount,
            fiatCurrency: inFlight.fiat_currency,
            createdAt: inFlight.created_at,
          });
        }
      }
    }
    if (tradeBalRes.success) {
      const map: Record<string, string> = {};
      for (const b of tradeBalRes.data) {
        map[b.token_symbol] = b.balance;
      }
      setBalances(map);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(async () => {
      const [poolRes, kycRes] = await Promise.all([
        getPoolData(),
        getTradeKycStatus(),
      ]);
      if (poolRes.success) setSpotPrice(poolRes.data.spotPrice);
      if (kycRes.success) setKyc(kycRes.data);
    }, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Reset when switching mode
  useEffect(() => {
    setAmount("");
    setBuyQuote(null);
    setSellQuote(null);
    setError(null);
    setSuccess(null);
  }, [mode]);

  // Debounced quote fetching
  useEffect(() => {
    if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    setBuyQuote(null);
    setSellQuote(null);
    setError(null);

    if (!amount || parseFloat(amount) <= 0) return;

    quoteTimeout.current = setTimeout(async () => {
      setQuoteLoading(true);
      if (mode === "buy") {
        const result = await getBuyQuote(currency, amount);
        if (result.success) {
          setBuyQuote(result.data as BuyQuoteData);
        } else {
          setError(result.error);
        }
      } else {
        const result = await getSellQuote(amount, payoutCurrency);
        if (result.success) {
          setSellQuote(result.data as SellQuoteData);
        } else {
          setError(result.error);
        }
      }
      setQuoteLoading(false);
    }, 500);

    return () => {
      if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    };
  }, [amount, currency, mode, payoutCurrency]);

  const handleCancelOrder = async () => {
    if (!activeOrder) return;
    setCancellingOrder(true);
    setPaymentCheckResult(null);
    try {
      const result = await cancelBuyOrderAction(activeOrder.orderId);
      if (result.success) {
        setActiveOrder(null);
        clearBuyIdempotencyKey();
        await loadData();
      } else {
        setError(result.error || "Failed to cancel order");
      }
    } catch {
      setError("Failed to cancel order");
    } finally {
      setCancellingOrder(false);
    }
  };

  const handleCheckPayment = async () => {
    if (!activeOrder) return;
    setCheckingPayment(true);
    setPaymentCheckResult(null);
    try {
      const result = await checkPendingPaymentAction(activeOrder.orderId);
      if (result.success && result.data) {
        setPaymentCheckResult(result.data.message);
        const transakStatus = result.data.transakStatus;

        // Also refresh order status from our DB — the webhook or background
        // process may have advanced the trade order independently.
        const statusRes = await getTradeOrderStatus(activeOrder.orderId);
        if (statusRes.success && statusRes.data) {
          const newStatus = statusRes.data.status;
          if (IN_FLIGHT_STATUSES.includes(newStatus)) {
            setActiveOrder((prev) =>
              prev ? { ...prev, status: newStatus, transakStatus } : null
            );
          } else {
            setActiveOrder(null);
            await loadData();
          }
        } else {
          // Even if our DB lookup failed, surface the Transak status so the
          // UI advances out of "Waiting for Payment".
          setActiveOrder((prev) =>
            prev ? { ...prev, transakStatus } : null
          );
        }
      } else {
        setPaymentCheckResult(
          "error" in result && result.error
            ? result.error
            : "Could not check payment status"
        );
      }
    } catch {
      setPaymentCheckResult("Failed to check payment status");
    } finally {
      setCheckingPayment(false);
    }
  };

  const handleExecute = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    if (activeOrder) {
      setError("You already have an order being processed. Please wait for it to complete.");
      return;
    }

    setExecuting(true);
    setError(null);
    setSuccess(null);

    if (mode === "buy") {
      if (!buyQuote) return setExecuting(false);

      if (!buyIdempotencyKeyRef.current) {
        buyIdempotencyKeyRef.current =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `buy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }

      const result = await createBuyOrderAction(
        currency,
        amount,
        buyIdempotencyKeyRef.current
      );
      if (result.success) {
        const data = result.data;

        if (data.pendingPayment && data.widgetUrl) {
          const newActive: ActiveOrder = {
            orderId: data.order.order_id,
            status: "pending_payment",
            fiatAmount: data.fiatAmount.toString(),
            fiatCurrency: data.fiatCurrency,
            createdAt: new Date().toISOString(),
          };
          setActiveOrder(newActive);
          setPendingBuy({
            orderId: data.order.order_id,
            widgetUrl: data.widgetUrl,
            fiatAmount: data.fiatAmount,
            fiatCurrency: data.fiatCurrency,
          });
          setExecuting(false);
          return;
        }

        const processResult = data.result!;
        if (processResult.status === "completed") {
          setError(null);
          setSuccess({
            message: `Bought ${formatNumber(processResult.tglobalAmount || buyQuote.tglobalAmount, 4)} PLAT`,
            txHash: processResult.txHash,
          });
        } else if (processResult.status === "slippage_fallback") {
          setSuccess(null);
          setError(processResult.error || "Price moved too much. USDX credited instead.");
        } else {
          setSuccess(null);
          setError(
            processResult.error ||
              "Order processing failed. Check Recent Buy Orders for details."
          );
        }
        setAmount("");
        setBuyQuote(null);
        clearBuyIdempotencyKey();
        loadData();
      } else {
        setError(result.error);
      }
    } else {
      if (!sellQuote) return setExecuting(false);

      const result = await createSellOrderAction(amount, payoutCurrency);
      if (result.success) {
        const order = result.data.order;
        const finalCurrency = (order.payout_currency || payoutCurrency) as FiatCurrency;
        const payoutToken = FIAT_TO_TOKEN[finalCurrency];
        const finalAmount =
          order.payout_amount && parseFloat(order.payout_amount) > 0
            ? order.payout_amount
            : sellQuote.payoutAmount;
        const conversionWarning =
          finalCurrency !== "USD" && order.failure_reason
            ? ` (${order.failure_reason})`
            : "";
        setSuccess({
          message: `Sold ${formatNumber(amount, 4)} PLAT for ~${formatNumber(finalAmount, finalCurrency === "USD" ? 2 : 4)} ${payoutToken}${conversionWarning}`,
          txHash: order.operator_tx_hash ?? undefined,
        });
        setAmount("");
        setSellQuote(null);
        loadData();
      } else {
        setError(result.error);
      }
    }

    setExecuting(false);
  };

  // Background polling for activeOrder — runs independently of the Transak modal.
  // Handles: modal open, modal closed, page reload recovery.
  // When status is pending_payment, also polls Transak API and processes if
  // payment completed (replaces webhook on localhost).
  useEffect(() => {
    if (!activeOrder) return;

    const poll = async () => {
      // If still waiting for payment, try to process via Transak API poll.
      // This is idempotent and safe — see pollActivePaymentAction comments.
      // The poll also returns the current Transak status so we can advance
      // the UI (Processing step, hide Cancel) before our webhook fires.
      let latestTransakStatus: string | null | undefined;
      if (activeOrder.status === "pending_payment") {
        const pollRes = await pollActivePaymentAction(activeOrder.orderId);
        if (pollRes.success && pollRes.data) {
          latestTransakStatus = pollRes.data.transakStatus;
        }
      }

      const res = await getTradeOrderStatus(activeOrder.orderId);
      if (!res.success) {
        // Still surface the Transak status so the UI can react even if our
        // own DB read failed transiently.
        if (latestTransakStatus !== undefined) {
          setActiveOrder((prev) =>
            prev ? { ...prev, transakStatus: latestTransakStatus } : null
          );
        }
        return;
      }

      const { status, tglobalAmount, txHash } = res.data;

      // Update activeOrder status in real time
      if (status !== activeOrder.status || latestTransakStatus !== undefined) {
        setActiveOrder((prev) =>
          prev
            ? {
                ...prev,
                status,
                tglobalAmount,
                txHash: txHash ?? undefined,
                ...(latestTransakStatus !== undefined
                  ? { transakStatus: latestTransakStatus }
                  : {}),
              }
            : null
        );
      }

      if (status === "completed") {
        setActiveOrder(null);
        closePendingBuy();
        clearBuyIdempotencyKey();
        setError(null);
        setSuccess({
          message: `Bought ${formatNumber(tglobalAmount, 4)} PLAT`,
          txHash: txHash ?? undefined,
        });
        setAmount("");
        setBuyQuote(null);
        loadData();
      } else if (status === "price_changed") {
        setActiveOrder(null);
        closePendingBuy();
        clearBuyIdempotencyKey();
        setRetryableOrder({
          orderId: activeOrder.orderId,
          status: "price_changed",
          message: "Price moved while your payment was processing. Your USDX has been returned to your balance.",
        });
        loadData();
      } else if (status === "insufficient_balance") {
        setActiveOrder(null);
        closePendingBuy();
        clearBuyIdempotencyKey();
        setRetryableOrder({
          orderId: activeOrder.orderId,
          status: "insufficient_balance",
          message: "Your balance changed while payment was processing. Your Transak deposit is in your balance.",
        });
        loadData();
      } else if (status === "slippage_fallback") {
        setActiveOrder(null);
        closePendingBuy();
        clearBuyIdempotencyKey();
        setSuccess(null);
        setError(
          res.data.failureReason ||
            "Price moved too much. Your USDX equivalent has been credited to your balance."
        );
        loadData();
      } else if (status === "failed" || status === "cancelled") {
        setActiveOrder(null);
        closePendingBuy();
        clearBuyIdempotencyKey();
        setSuccess(null);
        setError(
          res.data.failureReason ||
            "Order processing failed. See Recent Buy Orders for details."
        );
        loadData();
      }
    };

    // Longer interval while waiting on Transak (external API call each time),
    // shorter once payment is received and we're just checking our own DB.
    const intervalMs =
      activeOrder.status === "pending_payment" ? 15_000 : 5_000;

    activeOrderPollRef.current = setInterval(poll, intervalMs);
    poll();

    return () => {
      if (activeOrderPollRef.current) clearInterval(activeOrderPollRef.current);
    };
  }, [activeOrder?.orderId, activeOrder?.status, loadData]); // eslint-disable-line react-hooks/exhaustive-deps

  const closePendingBuy = () => {
    setPendingBuy(null);
  };

  const handleRetry = async () => {
    if (!retryableOrder || isRetrying) return;
    setIsRetrying(true);
    setError(null);

    try {
      const res = await retryBuyOrderAction(retryableOrder.orderId);
      if (res.success) {
        const { result } = res.data;
        if (result.status === "completed") {
          setSuccess({
            message: `Bought ${formatNumber(result.tglobalAmount || "0", 4)} PLAT`,
            txHash: result.txHash,
          });
        } else if (result.status === "slippage_fallback" || result.status === "price_changed") {
          setError(result.error || "Price moved too much. USDX credited to your balance.");
        } else {
          setError(result.error || "Trade execution failed.");
        }
        setAmount("");
        setBuyQuote(null);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError("Retry failed. Please try again.");
    } finally {
      setRetryableOrder(null);
      setIsRetrying(false);
      loadData();
    }
  };

  const currentPaymentToken = FIAT_TO_TOKEN[currency];
  const currentTokenBalance = parseFloat(balances[currentPaymentToken] || "0");

  const setMaxAmount = () => {
    if (mode === "sell") {
      setAmount(tglobalBalance);
    } else {
      if (currentTokenBalance > 0) {
        setAmount(currentTokenBalance.toString());
      }
    }
  };

  const hasQuote = mode === "buy" ? !!buyQuote : !!sellQuote;
  const kycLoaded = kyc !== null;
  const kycPassed = kyc ? (!kyc.kycRequired || kyc.kycApproved) : true;
  const canExecute =
    kycLoaded &&
    kycPassed &&
    amount &&
    parseFloat(amount) > 0 &&
    hasQuote &&
    !executing &&
    !activeOrder &&
    (mode === "buy" || parseFloat(amount) <= parseFloat(tglobalBalance));

  const filteredOrders = orders.filter((o) => o.order_type === mode);

  return (
    <>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Stats Row */}
      <div className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 rounded-2xl border border-emerald-500/20 p-4 shadow-lg">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">PLAT Price</p>
          <p className="text-xl font-bold text-white">
            ${spotPrice ? formatNumber(spotPrice, 4) : "..."}
          </p>
        </div>
        <div className="bg-gradient-to-br from-violet-500/10 to-violet-600/5 rounded-2xl border border-violet-500/20 p-4 shadow-lg">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Your PLAT</p>
          <p className="text-xl font-bold text-white">{formatNumber(tglobalBalance, 4)}</p>
        </div>
        <div className="bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 rounded-2xl border border-cyan-500/20 p-4 shadow-lg">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Portfolio Value</p>
          <p className="text-xl font-bold text-white">
            $
            {spotPrice
              ? formatNumber((parseFloat(tglobalBalance) * parseFloat(spotPrice)).toString(), 2)
              : "..."}
          </p>
        </div>
        <div className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 rounded-2xl border border-amber-500/20 p-4 shadow-lg">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Max Slippage</p>
          <p className="text-xl font-bold text-white">
            {(buyQuote?.maxSlippageBps || sellQuote?.maxSlippageBps || 200) / 100}%
          </p>
        </div>
      </div>

      {/* Trade Card */}
      <div className="lg:col-span-2">
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-6 shadow-xl">
          {/* Buy/Sell Toggle */}
          <div className="flex bg-slate-900/50 rounded-xl p-1 mb-6">
            <button
              onClick={() => setMode("buy")}
              className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all ${
                mode === "buy"
                  ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/25"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Buy PLAT
            </button>
            <button
              onClick={() => setMode("sell")}
              className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all ${
                mode === "sell"
                  ? "bg-red-500 text-white shadow-lg shadow-red-500/25"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Sell PLAT
            </button>
          </div>

          {/* KYC Required Banner */}
          {kycLoaded && !kycPassed && (
            <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-amber-400">KYC Verification Required</p>
                  <p className="text-xs text-amber-400/70 mt-1">
                    You must complete identity verification before trading PLAT.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Active Order Banner */}
          {activeOrder && mode === "buy" && (() => {
            // The trade order's DB status is the source of truth once the
            // webhook fires (payment_received → executing → completed). Before
            // that, the Transak status may already indicate the payment is
            // mid-processing — in that case we advance the UI to "Processing"
            // and disable Cancel so the user doesn't cancel a charged payment.
            const transakProcessing = isTransakProcessing(activeOrder.transakStatus);
            const isWaitingForPayment =
              activeOrder.status === "pending_payment" && !transakProcessing;
            const isProcessingPayment =
              transakProcessing ||
              activeOrder.status === "payment_received";
            const isExecuting = activeOrder.status === "executing";
            const canCancel = isWaitingForPayment;
            const headerLabel = isWaitingForPayment
              ? "Waiting for Payment"
              : transakProcessing &&
                  activeOrder.status === "pending_payment"
                ? "Processing Payment"
                : activeOrder.status === "payment_received"
                  ? "Payment Received"
                  : isExecuting
                    ? "Executing Trade"
                    : "Processing";
            const headerStatusClass = isWaitingForPayment
              ? "bg-amber-400"
              : "bg-blue-400";

            return (
            <div className="mb-6 rounded-xl border overflow-hidden animate-in fade-in duration-300"
              style={{
                borderColor: isWaitingForPayment ? "rgb(251 191 36 / 0.3)" :
                  "rgb(96 165 250 / 0.3)",
                background: isWaitingForPayment ? "rgb(251 191 36 / 0.05)" :
                  "rgb(96 165 250 / 0.05)",
              }}
            >
              <div className="p-4">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className={`w-3 h-3 rounded-full ${headerStatusClass}`} />
                      <div className={`absolute inset-0 w-3 h-3 rounded-full animate-ping ${headerStatusClass}`} />
                    </div>
                    <span className="text-sm font-semibold text-white">
                      {headerLabel}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400">
                    {timeAgo(activeOrder.createdAt)}
                  </span>
                </div>

                {/* Amount */}
                <div className="flex items-center justify-between mb-4 px-3 py-2.5 bg-slate-900/50 rounded-lg">
                  <span className="text-sm text-slate-400">Order Amount</span>
                  <span className="text-sm font-semibold text-white">
                    {CURRENCIES.find(c => c.id === activeOrder.fiatCurrency)?.symbol || "$"}
                    {formatNumber(activeOrder.fiatAmount, 2)} {activeOrder.fiatCurrency}
                  </span>
                </div>

                {/* Step Tracker */}
                <div className="flex items-center gap-2 mb-3">
                  {[
                    {
                      label: "Payment",
                      active: isWaitingForPayment,
                      done: !isWaitingForPayment,
                    },
                    {
                      label: "Processing",
                      active: isProcessingPayment,
                      done: isExecuting,
                    },
                    { label: "Complete", active: false, done: false },
                  ].map((step, i) => (
                    <div key={step.label} className="flex items-center gap-2 flex-1">
                      <div className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold flex-shrink-0 ${
                        step.done ? "bg-emerald-500 text-white" :
                        step.active ? (isWaitingForPayment ? "bg-amber-500/20 text-amber-400 ring-2 ring-amber-500/30" : "bg-blue-500/20 text-blue-400 ring-2 ring-blue-500/30") :
                        "bg-slate-700 text-slate-500"
                      }`}>
                        {step.done ? (
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (i + 1)}
                      </div>
                      <span className={`text-xs ${step.done ? "text-emerald-400" : step.active ? "text-white" : "text-slate-500"}`}>
                        {step.label}
                      </span>
                      {i < 2 && (
                        <div className={`flex-1 h-px ${step.done ? "bg-emerald-500/50" : "bg-slate-700"}`} />
                      )}
                    </div>
                  ))}
                </div>

                {/* Status message */}
                <p className="text-xs text-slate-400 text-center">
                  {isWaitingForPayment && "Complete your payment in the Transak window. Your trade will execute automatically."}
                  {transakProcessing &&
                    activeOrder.status === "pending_payment" &&
                    "Transak is processing your payment. This usually takes under a minute — please don't close this page."}
                  {activeOrder.status === "payment_received" && "Payment confirmed. Executing your PLAT swap on the AMM..."}
                  {isExecuting && "Swap in progress. This will complete shortly."}
                </p>

                {/* Payment check result */}
                {paymentCheckResult && (
                  <div className="mt-3 px-3 py-2.5 rounded-lg bg-slate-900/60 border border-slate-600/40">
                    <div className="flex items-start gap-2">
                      <svg className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p className="text-xs text-slate-300 leading-relaxed">{paymentCheckResult}</p>
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                {activeOrder.status === "pending_payment" && (
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={handleCheckPayment}
                      disabled={checkingPayment}
                      className="flex-1 py-2 px-3 text-xs font-medium rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-all disabled:opacity-50"
                    >
                      {checkingPayment ? (
                        <span className="flex items-center justify-center gap-1.5">
                          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Checking...
                        </span>
                      ) : "Check Payment Status"}
                    </button>
                    {canCancel && (
                      <button
                        onClick={handleCancelOrder}
                        disabled={cancellingOrder}
                        className="py-2 px-3 text-xs font-medium rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all disabled:opacity-50"
                      >
                        {cancellingOrder ? "Cancelling..." : "Cancel Order"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            );
          })()}

          {/* BUY MODE */}
          {mode === "buy" && (
            <>
              {/* Currency Selector */}
              <div className="mb-4">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">
                  Payment Currency
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {CURRENCIES.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setCurrency(c.id)}
                      className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        currency === c.id
                          ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/25"
                          : "bg-slate-700/50 text-slate-300 hover:bg-slate-700 border border-slate-600/50"
                      }`}
                    >
                      <span className="block text-lg mb-0.5">{c.flag}</span>
                      {c.id}
                    </button>
                  ))}
                </div>
              </div>

              {/* You Pay */}
              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mb-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">You Pay</span>
                  <span className="text-xs text-slate-500">
                    Balance: {formatNumber(currentTokenBalance, 2)} {currentPaymentToken}{" "}
                    {currentTokenBalance > 0 && (
                      <button onClick={setMaxAmount} className="text-emerald-400 hover:text-emerald-300 font-medium ml-1">
                        MAX
                      </button>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-2xl font-semibold text-slate-400 select-none">
                    {currencyInfo.symbol}
                  </div>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 bg-transparent text-2xl font-semibold text-white outline-none placeholder-slate-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    min="0"
                    step="any"
                  />
                </div>
                <div className="flex gap-2 mt-3">
                  {[50, 100, 500, 1000].map((val) => (
                    <button
                      key={val}
                      onClick={() => setAmount(val.toString())}
                      className="px-3 py-1 text-xs font-medium bg-slate-700/50 text-slate-300 hover:bg-slate-700 rounded-lg transition-colors"
                    >
                      {currencyInfo.symbol}{val}
                    </button>
                  ))}
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center -my-1 relative z-10">
                <div className="w-10 h-10 bg-slate-700 border-4 border-slate-800 rounded-xl flex items-center justify-center">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                </div>
              </div>

              {/* You Receive */}
              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mt-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">You Receive</span>
                  <span className="text-xs text-slate-500">PLAT</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    {quoteLoading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-slate-500 text-lg">Getting quote...</span>
                      </div>
                    ) : (
                      <span className={`text-2xl font-semibold ${buyQuote ? "text-white" : "text-slate-600"}`}>
                        {buyQuote ? formatNumber(buyQuote.tglobalAmount, 4) : "0.0000"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 rounded-xl">
                    <div className="w-6 h-6 rounded-full bg-violet-500 flex items-center justify-center text-xs font-bold text-white">T</div>
                    <span className="text-white font-medium">PLAT</span>
                  </div>
                </div>
              </div>

              {/* Payment Breakdown */}
              {buyQuote && (parseFloat(buyQuote.fromBalance) > 0 || parseFloat(buyQuote.toCharge) > 0) && (
                <div className="mt-4 p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 space-y-1.5">
                  {parseFloat(buyQuote.fromBalance) > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-emerald-400/80">From {buyQuote.paymentToken} Balance</span>
                      <span className="text-emerald-400 font-medium">
                        {currencyInfo.symbol}{formatNumber(buyQuote.fromBalance, 2)}
                      </span>
                    </div>
                  )}
                  {parseFloat(buyQuote.toCharge) > 0 && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-amber-400/80">Card Payment</span>
                        <span className="text-amber-400 font-medium">
                          {currencyInfo.symbol}{formatNumber(buyQuote.toCharge, 2)}
                        </span>
                      </div>
                      {buyQuote.transakFees && (
                        <>
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-400">Transak Fees (est.)</span>
                            <span className="text-red-400 font-medium">
                              ~{currencyInfo.symbol}{formatNumber(buyQuote.transakFees.totalFee.toString(), 2)}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm border-t border-slate-700/50 pt-1.5">
                            <span className="text-white font-medium">Net USDX for Trade</span>
                            <span className="text-white font-medium">
                              ${formatNumber(buyQuote.tusdAmount, 2)}
                            </span>
                          </div>
                        </>
                      )}
                    </>
                  )}
                  {parseFloat(buyQuote.toCharge) <= 0 && (
                    <p className="text-xs text-emerald-400/70">Fully covered by your {buyQuote.paymentToken} balance</p>
                  )}
                </div>
              )}

              {/* Transak limit warning: Lite KYC only for $20–$100 */}
              {buyQuote && parseFloat(buyQuote.toCharge) > 100 && (
                <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                  <p className="text-sm text-amber-400">
                    Payment over $100 requires extended verification. For quick sign-up (Lite KYC), keep payment at $100 or less.
                  </p>
                </div>
              )}

              {/* Buy Quote Details */}
              {buyQuote && (
                <div className="mt-4 p-4 bg-slate-900/30 rounded-xl space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">PLAT Spot Price</span>
                    <span className="text-white">${formatNumber(buyQuote.ammSpotPrice, 4)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Effective Price</span>
                    <span className="text-white">${formatNumber(buyQuote.ammEffectivePrice, 4)}</span>
                  </div>
                  {currency !== "USD" && (
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">{currency}/USD Rate</span>
                      <span className="text-white">{formatNumber(buyQuote.fiatToTusdRate, 4)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">USDX Equivalent</span>
                    <span className="text-white">${formatNumber(buyQuote.tusdAmount, 2)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Price Impact</span>
                    <span className={buyQuote.priceImpactBps > 100 ? "text-red-400" : buyQuote.priceImpactBps > 50 ? "text-amber-400" : "text-emerald-400"}>
                      {(buyQuote.priceImpactBps / 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">AMM Fee</span>
                    <span className="text-white">{formatNumber(buyQuote.feeAmount, 4)} USDX</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Slippage Tolerance</span>
                    <span className="text-white">{(buyQuote.maxSlippageBps / 100).toFixed(1)}%</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* SELL MODE */}
          {mode === "sell" && (
            <>
              {/* Payout Currency Selector */}
              <div className="mb-4">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">
                  Receive Currency
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {CURRENCIES.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setPayoutCurrency(c.id)}
                      className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        payoutCurrency === c.id
                          ? "bg-red-500 text-white shadow-lg shadow-red-500/25"
                          : "bg-slate-700/50 text-slate-300 hover:bg-slate-700 border border-slate-600/50"
                      }`}
                    >
                      <span className="block text-lg mb-0.5">{c.flag}</span>
                      {FIAT_TO_TOKEN[c.id]}
                    </button>
                  ))}
                </div>
              </div>

              {/* You Sell */}
              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mb-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">You Sell</span>
                  <span className="text-xs text-slate-500">
                    Balance: {formatNumber(tglobalBalance, 4)}{" "}
                    <button onClick={setMaxAmount} className="text-emerald-400 hover:text-emerald-300 font-medium ml-1">
                      MAX
                    </button>
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0000"
                    className="flex-1 bg-transparent text-2xl font-semibold text-white outline-none placeholder-slate-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    min="0"
                    step="any"
                  />
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 rounded-xl">
                    <div className="w-6 h-6 rounded-full bg-violet-500 flex items-center justify-center text-xs font-bold text-white">T</div>
                    <span className="text-white font-medium">PLAT</span>
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center -my-1 relative z-10">
                <div className="w-10 h-10 bg-slate-700 border-4 border-slate-800 rounded-xl flex items-center justify-center">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                </div>
              </div>

              {/* You Receive */}
              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mt-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">You Receive</span>
                  <span className="text-xs text-slate-500">{FIAT_TO_TOKEN[payoutCurrency]}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    {quoteLoading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-slate-500 text-lg">Getting quote...</span>
                      </div>
                    ) : (
                      <span className={`text-2xl font-semibold ${sellQuote ? "text-white" : "text-slate-600"}`}>
                        {sellQuote
                          ? formatNumber(sellQuote.payoutAmount, payoutCurrency === "USD" ? 4 : 4)
                          : "0.0000"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 rounded-xl">
                    <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white">
                      {CURRENCIES.find((c) => c.id === payoutCurrency)?.flag ?? "T"}
                    </div>
                    <span className="text-white font-medium">{FIAT_TO_TOKEN[payoutCurrency]}</span>
                  </div>
                </div>
              </div>

              {/* Sell Quote Details */}
              {sellQuote && (
                <div className="mt-4 p-4 bg-slate-900/30 rounded-xl space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">PLAT Spot Price</span>
                    <span className="text-white">${formatNumber(sellQuote.ammSpotPrice, 4)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Effective Price</span>
                    <span className="text-white">${formatNumber(sellQuote.ammEffectivePrice, 4)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">USDX from AMM</span>
                    <span className="text-white">${formatNumber(sellQuote.tusdAmount, 2)}</span>
                  </div>
                  {payoutCurrency !== "USD" && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-400">USDX/{FIAT_TO_TOKEN[payoutCurrency]} Rate</span>
                        <span className="text-white">{formatNumber(sellQuote.tusdToPayoutRate, 4)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-400">{FIAT_TO_TOKEN[payoutCurrency]} Received</span>
                        <span className="text-white">{formatNumber(sellQuote.payoutAmount, 4)} {FIAT_TO_TOKEN[payoutCurrency]}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Price Impact</span>
                    <span className={sellQuote.priceImpactBps > 100 ? "text-red-400" : sellQuote.priceImpactBps > 50 ? "text-amber-400" : "text-emerald-400"}>
                      {(sellQuote.priceImpactBps / 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">AMM Fee</span>
                    <span className="text-white">{formatNumber(sellQuote.feeAmount, 4)} PLAT</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Slippage Tolerance</span>
                    <span className="text-white">{(sellQuote.maxSlippageBps / 100).toFixed(1)}%</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div className="mt-4 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <p className="font-medium text-sm">{success.message}</p>
              {success.txHash && (
                <a
                  href={`https://basescan.org/tx/${success.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline hover:text-emerald-300 mt-1 inline-block font-mono break-all"
                >
                  View on BaseScan
                </a>
              )}
            </div>
          )}

          {/* Execute Button */}
          <button
            onClick={handleExecute}
            disabled={!canExecute}
            className={`w-full mt-4 py-4 rounded-xl font-semibold text-lg transition-all duration-200 ${
              canExecute
                ? mode === "buy"
                  ? "bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40"
                  : "bg-gradient-to-r from-red-500 to-orange-500 hover:from-red-600 hover:to-orange-600 text-white shadow-lg shadow-red-500/25 hover:shadow-red-500/40"
                : "bg-slate-700 text-slate-400 cursor-not-allowed"
            }`}
          >
            {activeOrder && mode === "buy" ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Order in Progress...
              </span>
            ) : executing ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Processing...
              </span>
            ) : !kycLoaded ? (
              "Loading..."
            ) : !kycPassed ? (
              "KYC Required"
            ) : !amount || parseFloat(amount) <= 0 ? (
              "Enter Amount"
            ) : mode === "sell" && parseFloat(amount) > parseFloat(tglobalBalance) ? (
              "Insufficient PLAT Balance"
            ) : !hasQuote ? (
              "Getting Quote..."
            ) : mode === "buy" ? (
              buyQuote && parseFloat(buyQuote.toCharge) <= 0
                ? "Buy PLAT (from balance)"
                : buyQuote && parseFloat(buyQuote.fromBalance) > 0
                  ? `Buy PLAT (${currencyInfo.symbol}${formatNumber(buyQuote.toCharge, 2)} to pay)`
                  : `Buy PLAT for ${currencyInfo.symbol}${formatNumber(amount, 2)}`
            ) : (
              `Sell ${formatNumber(amount, 4)} PLAT for ${FIAT_TO_TOKEN[payoutCurrency]}`
            )}
          </button>

          <p className="text-xs text-slate-500 mt-3 text-center">
            {mode === "buy"
              ? "Your balance is used first. Any remaining amount is paid via Transak. PLAT is credited to your balance."
              : payoutCurrency === "USD"
                ? "PLAT will be debited and swapped to USDX via AMM. USDX will be credited to your internal balance."
                : `PLAT will be debited and swapped to USDX via AMM, then converted to ${FIAT_TO_TOKEN[payoutCurrency]} using oracle rates and credited to your internal balance.`}
          </p>
        </div>
      </div>

      {/* Sidebar */}
      <div className="space-y-4 lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto lg:sticky lg:top-24 pr-1">
        {/* Balance Card */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-violet-500 flex items-center justify-center text-[10px] font-bold text-white">T</div>
            PLAT Balance
          </h3>
          <p className="text-3xl font-bold text-white">{formatNumber(tglobalBalance, 4)}</p>
          {spotPrice && (
            <p className="text-sm text-slate-400 mt-1">
              ~${formatNumber((parseFloat(tglobalBalance) * parseFloat(spotPrice)).toString(), 2)} USD
            </p>
          )}
        </div>

        {/* Recent Orders */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white">
              Recent {mode === "buy" ? "Buy" : "Sell"} Orders
            </h3>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-xs text-emerald-400 hover:text-emerald-300"
            >
              {showHistory ? "Hide" : "Show All"}
            </button>
          </div>

          {filteredOrders.length === 0 ? (
            <p className="text-sm text-slate-500">No {mode} orders yet</p>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {filteredOrders.slice(0, showHistory ? 20 : 5).map((order) => {
                const isInFlight = IN_FLIGHT_STATUSES.includes(order.status);
                return (
                <div
                  key={order.order_id}
                  className={`p-3 rounded-xl border ${
                    isInFlight
                      ? "bg-amber-500/5 border-amber-500/20 ring-1 ring-amber-500/10"
                      : "bg-slate-900/50 border-slate-700/30"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-white flex items-center gap-1.5">
                      {isInFlight && (
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
                        </span>
                      )}
                      {order.order_type === "buy"
                        ? `${order.fiat_currency} ${formatNumber(order.fiat_amount, 2)}`
                        : `${formatNumber(order.tglobal_amount, 4)} PLAT`}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        STATUS_COLORS[order.status] || "text-slate-400 bg-slate-400/10"
                      }`}
                    >
                      {order.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      {order.order_type === "buy"
                        ? parseFloat(order.tglobal_amount) > 0
                          ? `${formatNumber(order.tglobal_amount, 4)} PLAT`
                          : "Pending"
                        : `${formatNumber(order.tusd_amount, 2)} USDX`}
                    </span>
                    <span className="text-xs text-slate-500">
                      {new Date(order.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {order.operator_tx_hash && (
                    <a
                      href={`https://basescan.org/tx/${order.operator_tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-emerald-400/60 hover:text-emerald-400 font-mono mt-1 block truncate"
                    >
                      {order.operator_tx_hash}
                    </a>
                  )}
                  {order.failure_reason &&
                    order.status !== "completed" &&
                    order.status !== "pending_payment" &&
                    order.status !== "payment_received" &&
                    order.status !== "executing" && (
                      <p
                        className="text-[10px] text-red-400/90 mt-1.5 leading-snug line-clamp-4"
                        title={order.failure_reason}
                      >
                        {order.failure_reason}
                      </p>
                    )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Transak Payment Modal */}
      {pendingBuy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="relative w-full max-w-lg mx-4 bg-slate-900 rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  {activeOrder && activeOrder.status !== "pending_payment"
                    ? "Processing Trade"
                    : activeOrder && isTransakProcessing(activeOrder.transakStatus)
                      ? "Processing Payment"
                      : "Complete Payment"}
                </h3>
                <p className="text-sm text-slate-400 mt-0.5">
                  {activeOrder && activeOrder.status !== "pending_payment"
                    ? "Payment received — executing trade..."
                    : activeOrder && isTransakProcessing(activeOrder.transakStatus)
                      ? "Transak is processing your payment..."
                      : `Pay ${currencyInfo.symbol}${formatNumber(pendingBuy.fiatAmount, 2)} via Transak`}
                </p>
              </div>
              <button
                onClick={closePendingBuy}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Widget Container */}
            <div className="relative">
              {activeOrder && activeOrder.status !== "pending_payment" ? (
                <div className="flex items-center justify-center bg-slate-900/90" style={{ height: "400px" }}>
                  <div className="flex flex-col items-center gap-4 p-8">
                    <div className="w-12 h-12 border-[3px] border-emerald-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-center">
                      <p className="text-lg font-semibold text-white">Processing Your Trade</p>
                      <p className="text-sm text-slate-400 mt-1">
                        Payment confirmed. Executing PLAT swap on AMM...
                      </p>
                      <p className="text-xs text-slate-500 mt-3">
                        You can close this window — your trade will complete in the background.
                      </p>
                    </div>
                  </div>
                </div>
              ) : activeOrder && isTransakProcessing(activeOrder.transakStatus) ? (
                <div className="flex items-center justify-center bg-slate-900/90" style={{ height: "400px" }}>
                  <div className="flex flex-col items-center gap-4 p-8">
                    <div className="w-12 h-12 border-[3px] border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-center">
                      <p className="text-lg font-semibold text-white">Processing Payment</p>
                      <p className="text-sm text-slate-400 mt-1">
                        Transak is processing your payment. Your trade will execute automatically once it clears.
                      </p>
                      <p className="text-xs text-slate-500 mt-3">
                        You can close this window — the order will continue in the background.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <iframe
                  src={pendingBuy.widgetUrl}
                  style={{ height: "700px", width: "100%", border: "none" }}
                  allow="camera;microphone;payment"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-slate-700/50 bg-slate-900/50">
              <p className="text-xs text-slate-500 text-center">
                Secure payment powered by Transak. You can safely close this window — your order will continue processing in the background.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Retry Modal — shown when Transak payment succeeded but trade couldn't auto-execute */}
      {retryableOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md mx-4 bg-slate-900 rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-700/50">
              <h3 className="text-lg font-semibold text-white">
                {retryableOrder.status === "price_changed"
                  ? "Price Changed"
                  : "Balance Changed"}
              </h3>
            </div>

            <div className="px-6 py-6 space-y-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {retryableOrder.message}
                </p>
              </div>

              <p className="text-sm text-slate-400">
                Your funds are safe in your balance. You can trade at the current market price.
              </p>
            </div>

            <div className="px-6 py-4 border-t border-slate-700/50 flex gap-3">
              <button
                onClick={() => { setRetryableOrder(null); loadData(); }}
                className="flex-1 px-4 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-800 transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isRetrying ? "Executing..." : "Trade at Current Price"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

      {toastBanner && (
        <div
          className={`fixed bottom-6 left-1/2 z-[100] max-w-md w-[calc(100%-2rem)] -translate-x-1/2 rounded-xl border px-4 py-3 shadow-lg text-sm pointer-events-none ${
            toastBanner.variant === "error"
              ? "bg-red-950/95 border-red-500/35 text-red-100"
              : "bg-emerald-950/95 border-emerald-500/35 text-emerald-100"
          }`}
          role="alert"
        >
          {toastBanner.message}
        </div>
      )}
    </>
  );
}
