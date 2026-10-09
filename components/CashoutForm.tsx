// components/CashoutForm.tsx
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  getCashoutQuoteAction,
  initiateCashoutTransakAction,
  processWalletRedirectionAction,
  getCashoutStatusAction,
  getMyCashoutHistory,
  getMyBalances,
  reconcileAwaitingCashouts,
} from "@/app/actions/cashout";

type CashoutToken = "USDX" | "GBPX" | "EURX" | "BRLX" | "PLAT";

interface CashoutQuoteData {
  token: CashoutToken;
  tokenAmount: string;
  tusdEquivalent: string;
  conversionRate: number;
  fiatCurrency: string;
  fiatAmount: string;
  transakFeePct: number;
  transakFeeAmount: string;
  transakFeeBreakdown?: { name: string; value: number }[];
  platformFeePct: number;
  platformFeeAmount: string;
  totalFees: string;
  netReceive: string;
  minSellUsd: number;
  ammDetails?: {
    spotPrice: string;
    effectivePrice: string;
    priceImpactBps: number;
    feeAmount: string;
  };
}

interface CashoutOrderData {
  cashout_id: string;
  token: string;
  token_amount: string;
  fiat_amount: string;
  status: string;
  created_at: string;
}

const TOKENS: { id: CashoutToken; label: string; color: string; icon: string }[] = [
  { id: "USDX", label: "USDX", color: "emerald", icon: "\u{1F1FA}\u{1F1F8}" },
  { id: "GBPX", label: "GBPX", color: "blue", icon: "\u{1F1EC}\u{1F1E7}" },
  { id: "EURX", label: "EURX", color: "indigo", icon: "\u{1F1EA}\u{1F1FA}" },
  { id: "BRLX", label: "BRLX", color: "green", icon: "\u{1F1E7}\u{1F1F7}" },
  { id: "PLAT", label: "PLAT", color: "violet", icon: "T" },
];

const STATUS_COLORS: Record<string, string> = {
  processing: "text-cyan-400 bg-cyan-400/10",
  awaiting_transak: "text-amber-400 bg-amber-400/10",
  crypto_sent: "text-sky-400 bg-sky-400/10",
  pending_payout: "text-amber-400 bg-amber-400/10",
  payout_sent: "text-blue-400 bg-blue-400/10",
  completed: "text-emerald-400 bg-emerald-400/10",
  failed: "text-red-400 bg-red-400/10",
};

const IN_FLIGHT_STATUSES = ["processing", "awaiting_transak", "crypto_sent"];

function formatNumber(value: string | number, decimals = 2): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "0.00";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Short label for UI; copy still uses the full `cashout_id`. */
function formatOrderIdForDisplay(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export default function CashoutForm() {
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [selectedToken, setSelectedToken] = useState<CashoutToken>("USDX");
  const [amount, setAmount] = useState("");
  const [payoutCurrency] = useState("USD");

  const [quote, setQuote] = useState<CashoutQuoteData | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [balances, setBalances] = useState<Record<string, string>>({});
  const [cashouts, setCashouts] = useState<CashoutOrderData[]>([]);
  /** Set while “Copied” hint should show for that cashout row (or in-progress banner). */
  const [copiedScopeId, setCopiedScopeId] = useState<string | null>(null);

  const [activeCashout, setActiveCashout] = useState<{
    cashoutId: string;
    status: string;
  } | null>(null);

  const quoteTimeout = useRef<NodeJS.Timeout | null>(null);
  const activeCashoutRef = useRef(activeCashout);
  activeCashoutRef.current = activeCashout;

  // Client-generated idempotency key for the current cashout intent. Re-used
  // across retries of the same submission so a flaky DB/network doesn't
  // produce duplicate cashout orders. Cleared on terminal outcome.
  const cashoutIdempotencyKeyRef = useRef<string | null>(null);
  const clearCashoutIdempotencyKey = useCallback(() => {
    cashoutIdempotencyKeyRef.current = null;
  }, []);

  const searchParams = useSearchParams();
  const router = useRouter();
  const redirectProcessed = useRef(false);

  const reconcileRan = useRef(false);

  const loadData = useCallback(async () => {
    // On first load, reconcile any stale awaiting_transak orders automatically
    if (!reconcileRan.current) {
      reconcileRan.current = true;
      reconcileAwaitingCashouts().catch(() => {});
    }

    const [balRes, histRes] = await Promise.all([
      getMyBalances(),
      getMyCashoutHistory(20, 0),
    ]);
    if (balRes.success) {
      const map: Record<string, string> = {};
      balRes.data.forEach((b) => {
        map[b.token_symbol] = b.balance;
      });
      setBalances(map);
    }
    if (histRes.success) {
      const list = histRes.data as CashoutOrderData[];
      setCashouts(list);

      if (!activeCashoutRef.current) {
        const inflight = list.find((o) => IN_FLIGHT_STATUSES.includes(o.status));
        if (inflight) {
          setActiveCashout({ cashoutId: inflight.cashout_id, status: inflight.status });
        }
      }
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Poll active cashout status (webhook updates happen server-side)
  useEffect(() => {
    if (!activeCashout?.cashoutId) return;

    const tick = async () => {
      const res = await getCashoutStatusAction(activeCashout.cashoutId);
      if (!res.success || !res.data) return;

      const { status } = res.data;
      setActiveCashout((prev) => (prev ? { ...prev, status } : null));

      if (status === "completed") {
        setSuccess("Cash out complete. Fiat payout was processed by Transak.");
        setActiveCashout(null);
        clearCashoutIdempotencyKey();
        setAmount("");
        setQuote(null);
        setStep("select");
        loadData();
      } else if (status === "failed") {
        setError(res.data.failureReason || "Cash out failed.");
        setActiveCashout(null);
        clearCashoutIdempotencyKey();
        loadData();
      }
    };

    const id = setInterval(tick, 15000);
    tick();
    return () => clearInterval(id);
  }, [activeCashout?.cashoutId, loadData]);

  // Process Transak redirect params (walletAddress from the new tab redirect)
  useEffect(() => {
    if (redirectProcessed.current) return;
    const done = searchParams.get("transakDone");
    const walletAddress = searchParams.get("walletAddress");
    const partnerOrderId = searchParams.get("partnerOrderId");
    const transakOrderId =
      searchParams.getAll("orderId").find((id) => id.includes("-")) || "";

    if (!done || !walletAddress || !partnerOrderId) return;
    redirectProcessed.current = true;

    router.replace("/cashout", { scroll: false });

    (async () => {
      setActiveCashout({ cashoutId: partnerOrderId, status: "awaiting_transak" });
      const result = await processWalletRedirectionAction(
        partnerOrderId,
        walletAddress,
        transakOrderId
      );
      if (result.success) {
        setActiveCashout({ cashoutId: partnerOrderId, status: result.data.status });
        setSuccess("Crypto transfer initiated. Waiting for Transak to confirm fiat payout.");
      } else {
        setError(result.error);
      }
      loadData();
    })();
  }, [searchParams, router, loadData]);

  useEffect(() => {
    if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    setQuote(null);
    setError(null);

    if (!amount || parseFloat(amount) <= 0) return;

    quoteTimeout.current = setTimeout(async () => {
      setQuoteLoading(true);
      const result = await getCashoutQuoteAction(selectedToken, amount, payoutCurrency);
      if (result.success) {
        setQuote(result.data as CashoutQuoteData);
      } else {
        setError(result.error);
      }
      setQuoteLoading(false);
    }, 500);

    return () => {
      if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    };
  }, [amount, selectedToken, payoutCurrency]);

  const tokenBalance = balances[selectedToken] || "0";

  const handleNext = () => {
    if (step === "select") {
      if (!quote) return;
      if (parseFloat(amount) > parseFloat(tokenBalance)) {
        setError("Insufficient balance");
        return;
      }
      setError(null);
      setStep("confirm");
    }
  };

  const handleBack = () => {
    setError(null);
    if (step === "confirm") setStep("select");
  };

  const handleStartTransak = async () => {
    if (!quote || executing) return;
    setExecuting(true);
    setError(null);
    setSuccess(null);

    // Pre-check popup capability before debiting the user's balance
    const testWin = window.open("about:blank", "_blank");
    if (!testWin) {
      setError(
        "Pop-ups are blocked. Please allow pop-ups for this site in your browser settings, then try again."
      );
      setExecuting(false);
      return;
    }
    testWin.close();

    if (!cashoutIdempotencyKeyRef.current) {
      cashoutIdempotencyKeyRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `cashout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    const result = await initiateCashoutTransakAction(
      selectedToken,
      amount,
      payoutCurrency,
      cashoutIdempotencyKeyRef.current
    );

    if (result.success) {
      const { cashoutId, widgetUrl } = result.data;
      setActiveCashout({ cashoutId, status: result.data.order.status });
      window.open(widgetUrl, "_blank", "noopener");
      loadData();
    } else {
      setError(result.error);
    }
    setExecuting(false);
  };

  const setMaxAmount = () => {
    setAmount(tokenBalance);
  };

  const copyOrderId = async (scopeId: string, cashoutId: string) => {
    try {
      await navigator.clipboard.writeText(`Order ID: ${cashoutId}`);
      setCopiedScopeId(scopeId);
      window.setTimeout(() => {
        setCopiedScopeId((cur) => (cur === scopeId ? null : cur));
      }, 2000);
    } catch {
      setCopiedScopeId(null);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {activeCashout && IN_FLIGHT_STATUSES.includes(activeCashout.status) && (
        <div className="lg:col-span-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-200">Cash out in progress</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-400 shrink-0">Order ID</span>
                <button
                  type="button"
                  onClick={() => copyOrderId(activeCashout.cashoutId, activeCashout.cashoutId)}
                  className="font-mono text-xs text-amber-100/90 text-left rounded px-1.5 py-0.5 hover:bg-amber-500/10 border border-amber-500/20 transition-colors"
                  title="Click to copy full order ID"
                >
                  {formatOrderIdForDisplay(activeCashout.cashoutId)}
                </button>
                {copiedScopeId === activeCashout.cashoutId && (
                  <span className="text-xs text-emerald-400">Copied</span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Status: {activeCashout.status.replace(/_/g, " ")}.
                {activeCashout.status === "awaiting_transak" &&
                  " Complete the Transak flow in the new tab. When asked to send crypto, press \"I've sent the payment\" — we send it on your behalf automatically."}
                {activeCashout.status === "crypto_sent" &&
                  " Crypto sent to Transak. Waiting for fiat payout confirmation."}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
        {TOKENS.map((t) => {
          const bal = balances[t.id] || "0";
          const isSelected = selectedToken === t.id && step === "select";
          return (
            <button
              key={t.id}
              onClick={() => {
                if (step === "select") {
                  setSelectedToken(t.id);
                  setAmount("");
                  setQuote(null);
                  setError(null);
                }
              }}
              className={`p-3 rounded-2xl border transition-all text-left ${
                isSelected
                  ? "bg-emerald-500/10 border-emerald-500/40 shadow-lg shadow-emerald-500/10"
                  : "bg-gradient-to-br from-slate-800 to-slate-800/50 border-slate-700/50 hover:border-slate-600"
              }`}
            >
              <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">
                {t.icon} {t.label}
              </p>
              <p className="text-lg font-bold text-white">{formatNumber(bal, 4)}</p>
            </button>
          );
        })}
      </div>

      <div className="lg:col-span-2">
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-6 shadow-xl">
          <div className="flex items-center gap-2 mb-6">
            {["Select amount", "Confirm & Transak"].map((label, i) => {
              const stepNames = ["select", "confirm"] as const;
              const isActive = step === stepNames[i];
              const isCompleted = stepNames.indexOf(step) > i;
              return (
                <div key={label} className="flex items-center gap-2 flex-1">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                      isActive
                        ? "bg-emerald-500 text-white"
                        : isCompleted
                          ? "bg-emerald-500/30 text-emerald-400"
                          : "bg-slate-700 text-slate-400"
                    }`}
                  >
                    {isCompleted ? "\u2713" : i + 1}
                  </div>
                  <span
                    className={`text-sm hidden sm:inline ${isActive ? "text-white font-medium" : "text-slate-400"}`}
                  >
                    {label}
                  </span>
                  {i < 1 && <div className="flex-1 h-px bg-slate-700 mx-2" />}
                </div>
              );
            })}
          </div>

          {step === "select" && (
            <>
              <div className="mb-4">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">
                  Token to cash out
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {TOKENS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setSelectedToken(t.id);
                        setAmount("");
                        setQuote(null);
                      }}
                      className={`px-2 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        selectedToken === t.id
                          ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/25"
                          : "bg-slate-700/50 text-slate-300 hover:bg-slate-700 border border-slate-600/50"
                      }`}
                    >
                      {t.id === "PLAT" ? "T" : t.icon}
                      <span className="block text-xs mt-0.5">{t.id}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">Amount</span>
                  <span className="text-xs text-slate-500">
                    Balance: {formatNumber(tokenBalance, 4)}{" "}
                    <button
                      type="button"
                      onClick={setMaxAmount}
                      className="text-[emerald-400] hover:text-emerald-300 font-medium ml-1"
                    >
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
                    <span className="text-white font-medium">{selectedToken}</span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">You receive (est.)</span>
                  <span className="text-xs text-slate-500">USD</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-2xl font-semibold text-slate-400 select-none">$</div>
                  <div className="flex-1">
                    {quoteLoading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-slate-500 text-lg">Getting quote...</span>
                      </div>
                    ) : (
                      <span className={`text-2xl font-semibold ${quote ? "text-emerald-400" : "text-slate-600"}`}>
                        {quote ? formatNumber(quote.netReceive, 2) : "0.00"}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {quote && (
                <div className="mt-4 p-4 bg-slate-900/30 rounded-xl space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Gross value (USD)</span>
                    <span className="text-white">${formatNumber(quote.fiatAmount, 2)}</span>
                  </div>
                  {selectedToken !== "USDX" && !quote.ammDetails && (
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">{selectedToken}/USD rate</span>
                      <span className="text-white">{formatNumber(quote.conversionRate, 4)}</span>
                    </div>
                  )}
                  {quote.ammDetails && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-400">AMM effective price</span>
                        <span className="text-white">${formatNumber(quote.ammDetails.effectivePrice, 4)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-400">Price impact</span>
                        <span
                          className={
                            quote.ammDetails.priceImpactBps > 100
                              ? "text-red-400"
                              : quote.ammDetails.priceImpactBps > 50
                                ? "text-amber-400"
                                : "text-emerald-400"
                          }
                        >
                          {(quote.ammDetails.priceImpactBps / 100).toFixed(2)}%
                        </span>
                      </div>
                    </>
                  )}
                  <div className="h-px bg-slate-700/50 my-1" />
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-400">Transak fee (est.)</span>
                    <span className="text-red-400">~${formatNumber(quote.transakFeeAmount, 2)}</span>
                  </div>
                  {quote.transakFeeBreakdown && quote.transakFeeBreakdown.length > 0 && (
                    <div className="ml-3 space-y-0.5">
                      {quote.transakFeeBreakdown.map((item, i) => (
                        <div key={i} className="flex justify-between text-xs">
                          <span className="text-slate-500">{item.name}</span>
                          <span className="text-slate-500">${formatNumber(item.value, 2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {quote.platformFeePct > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">PLAT Investment fee ({quote.platformFeePct}%)</span>
                      <span className="text-red-400">-${formatNumber(quote.platformFeeAmount, 2)}</span>
                    </div>
                  )}
                  <div className="h-px bg-slate-700/50 my-1" />
                  <div className="flex justify-between text-sm font-medium">
                    <span className="text-slate-300">You receive</span>
                    <span className="text-emerald-400">${formatNumber(quote.netReceive, 2)}</span>
                  </div>
                </div>
              )}

              {quote && parseFloat(quote.fiatAmount) < quote.minSellUsd && (
                <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  Minimum cash out is ${formatNumber(quote.minSellUsd, 2)} USD. Increase your amount.
                </div>
              )}

              <button
                type="button"
                onClick={handleNext}
                disabled={
                  !quote ||
                  !amount ||
                  parseFloat(amount) <= 0 ||
                  parseFloat(amount) > parseFloat(tokenBalance) ||
                  parseFloat(quote?.fiatAmount || "0") < (quote?.minSellUsd || 10.5)
                }
                className={`w-full mt-4 py-4 rounded-xl font-semibold text-lg transition-all duration-200 ${
                  quote &&
                  amount &&
                  parseFloat(amount) > 0 &&
                  parseFloat(amount) <= parseFloat(tokenBalance) &&
                  parseFloat(quote.fiatAmount) >= quote.minSellUsd
                    ? "bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white shadow-lg shadow-emerald-500/25"
                    : "bg-slate-700 text-slate-400 cursor-not-allowed"
                }`}
              >
                Continue
              </button>
            </>
          )}

          {step === "confirm" && quote && (
            <>
              <h3 className="text-lg font-semibold text-white mb-4">Confirm cash out</h3>
              <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-5 space-y-3 mb-6">
                <div className="flex justify-between">
                  <span className="text-slate-400">You cash out</span>
                  <span className="text-white font-semibold">
                    {formatNumber(amount, 4)} {selectedToken}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Gross value</span>
                  <span className="text-white">${formatNumber(quote.fiatAmount, 2)}</span>
                </div>
                <div className="h-px bg-slate-700/50" />
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Transak fee (est.)</span>
                  <span className="text-red-400/80">~${formatNumber(quote.transakFeeAmount, 2)}</span>
                </div>
                {quote.transakFeeBreakdown && quote.transakFeeBreakdown.length > 0 && (
                  <div className="ml-3 space-y-0.5">
                    {quote.transakFeeBreakdown.map((item, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-slate-600">{item.name}</span>
                        <span className="text-slate-600">${formatNumber(item.value, 2)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {quote.platformFeePct > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">PLAT Investment fee ({quote.platformFeePct}%)</span>
                    <span className="text-red-400/80">-${formatNumber(quote.platformFeeAmount, 2)}</span>
                  </div>
                )}
                <div className="h-px bg-slate-700/50" />
                <div className="flex justify-between font-semibold">
                  <span className="text-slate-300">You receive (est.)</span>
                  <span className="text-emerald-400">${formatNumber(quote.netReceive, 2)}</span>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-sm mb-4 space-y-2">
                <p>Your balance will be debited immediately. Transak opens in a new tab — complete KYC and
                add your bank details there.</p>
                <p className="font-semibold">Important: When Transak asks you to send crypto, press
                &quot;I&apos;ve sent the payment&quot; — the platform sends it on your behalf automatically.</p>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleBack}
                  className="flex-1 py-3 rounded-xl font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleStartTransak}
                  disabled={executing}
                  className={`flex-1 py-3 rounded-xl font-semibold transition-all ${
                    executing
                      ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                      : "bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white shadow-lg shadow-emerald-500/25"
                  }`}
                >
                  {executing ? "Starting…" : "Open Transak (new tab)"}
                </button>
              </div>
            </>
          )}

          {error && (
            <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="mt-4 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              {success}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-4">How it works</h3>
          <div className="space-y-3">
            {[
              { step: "1", text: "Choose token and amount" },
              { step: "2", text: "Confirm — balance is debited" },
              { step: "3", text: "Complete Transak (KYC & bank) in the new tab — press \"I've sent the payment\" when prompted, we send crypto on your behalf" },
              { step: "4", text: "Fiat arrives in your bank automatically" },
            ].map((item) => (
              <div key={item.step} className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                  {item.step}
                </div>
                <p className="text-sm text-slate-400">{item.text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-4">Recent cash outs</h3>
          {cashouts.length === 0 ? (
            <p className="text-sm text-slate-500">None yet</p>
          ) : (
            <div className="space-y-2">
              {cashouts.slice(0, 5).map((c) => (
                <div key={c.cashout_id} className="p-3 bg-slate-900/50 rounded-xl border border-slate-700/30">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-white">
                      {formatNumber(c.token_amount, 4)} {c.token}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[c.status] || "text-slate-400 bg-slate-400/10"}`}
                    >
                      {c.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-400">${formatNumber(c.fiat_amount, 2)} USD</span>
                    <span className="text-xs text-slate-500">{new Date(c.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-700/40 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="text-slate-500 shrink-0">Order ID</span>
                    <button
                      type="button"
                      onClick={() => copyOrderId(c.cashout_id, c.cashout_id)}
                      className="font-mono text-slate-300 text-left rounded px-1 py-0.5 hover:bg-slate-800 hover:text-emerald-400 transition-colors"
                      title="Click to copy full order ID"
                    >
                      {formatOrderIdForDisplay(c.cashout_id)}
                    </button>
                    {copiedScopeId === c.cashout_id && (
                      <span className="text-emerald-400">Copied</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
