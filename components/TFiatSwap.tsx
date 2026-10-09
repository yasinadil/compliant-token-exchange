// components/TFiatSwap.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getMyBalances,
  getCurrentRates,
  getQuote,
  executeSwapAction,
  getMySecurityInfo,
  checkKycStatus,
} from "@/app/actions/swap";

const TOKENS = [
  { symbol: "USDX", name: "PLAT Dollar", flag: "🇺🇸" },
  { symbol: "GBPX", name: "PLAT Pound", flag: "🇬🇧" },
  { symbol: "EURX", name: "PLAT Euro", flag: "🇪🇺" },
  { symbol: "BRLX", name: "PLAT Real", flag: "🇧🇷" },
];

interface TFiatSwapProps {
  onSwapComplete?: () => void;
}

function stableTokenDisplayName(symbol: string): string {
  const names: Record<string, string> = {
    USDX: "PLAT Dollar (USDX)",
    EURX: "PLAT Euro (EURX)",
    GBPX: "PLAT Pound (GBPX)",
    BRLX: "PLAT Real (BRLX)",
  };

  return names[symbol] ?? symbol;
}

export default function TFiatSwap({ onSwapComplete }: TFiatSwapProps) {
  const [fromToken, setFromTokenState] = useState("USDX");
  const [toToken, setToTokenState] = useState("GBPX");

  // Prevent same token selection
  const setFromToken = (token: string) => {
    if (token === toToken) {
      // Swap tokens
      setToTokenState(fromToken);
    }
    setFromTokenState(token);
  };

  const setToToken = (token: string) => {
    if (token === fromToken) {
      // Swap tokens
      setFromTokenState(toToken);
    }
    setToTokenState(token);
  };

  // Get available tokens for each dropdown (exclude the other selected token)
  const fromTokenOptions = TOKENS;
  const toTokenOptions = TOKENS.filter((t) => t.symbol !== fromToken);
  const [fromAmount, setFromAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [rate, setRate] = useState<number | null>(null);
  const [processingFee, setProcessingFee] = useState<{ bps: number; usd: string } | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [heldBalances, setHeldBalances] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    txId?: string;
    requiresApproval?: boolean;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [kycApproved, setKycApproved] = useState<boolean | null>(null);
  const [kycRequired, setKycRequired] = useState(true);
  const [securityInfo, setSecurityInfo] = useState<{
    rateLimit: { remaining: number; resetInSeconds: number };
    dailyLimit: { usedToday: number; remaining: number; limit: number };
    dailyTradeCount: { tradesUsed: number; maxTrades: number };
    thresholds: { approvalThresholdUsd: number };
  } | null>(null);
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);

  // Load balances, rates, and security info on mount
  useEffect(() => {
    async function loadData() {
      setInitialLoading(true);

      const [balancesRes, ratesRes, securityRes, kycRes] = await Promise.all([
        getMyBalances(),
        getCurrentRates(),
        getMySecurityInfo(),
        checkKycStatus(),
      ]);

      if (balancesRes.success) {
        const balanceMap: Record<string, string> = {};
        const heldMap: Record<string, string> = {};
        balancesRes.balances.forEach((b) => {
          balanceMap[b.token_symbol] = b.balance;
          heldMap[b.token_symbol] = b.held;
        });
        setBalances(balanceMap);
        setHeldBalances(heldMap);
      }

      if (kycRes.success) {
        setKycApproved(kycRes.kycApproved);
        setKycRequired(kycRes.kycRequired);
      }

      if (securityRes.success) {
        setSecurityInfo({
          rateLimit: securityRes.rateLimit,
          dailyLimit: securityRes.dailyLimit,
          dailyTradeCount: securityRes.dailyTradeCount,
          thresholds: securityRes.thresholds,
        });
      }

      if (ratesRes.success) {
        setRates(ratesRes.rates);
      }

      setInitialLoading(false);
    }

    loadData();
  }, []);

  // Get quote when amount or tokens change
  const fetchQuote = useCallback(async () => {
    if (!fromAmount || parseFloat(fromAmount) <= 0) {
      setToAmount("");
      setRate(null);
      setProcessingFee(null);
      return;
    }

    if (fromToken === toToken) {
      setToAmount(fromAmount);
      setRate(1);
      setProcessingFee(null);
      return;
    }

    setQuoteLoading(true);
    const quoteRes = await getQuote(fromToken, toToken, fromAmount);

    if (quoteRes.success) {
      setToAmount(parseFloat(quoteRes.quote.toAmount).toFixed(6));
      setRate(quoteRes.quote.rate);
      if (quoteRes.quote.processingFeeBps > 0) {
        setProcessingFee({
          bps: quoteRes.quote.processingFeeBps,
          usd: quoteRes.quote.processingFeeUsd,
        });
      } else {
        setProcessingFee(null);
      }
    } else {
      setToAmount("");
      setRate(null);
      setProcessingFee(null);
    }
    setQuoteLoading(false);
  }, [fromToken, toToken, fromAmount]);

  useEffect(() => {
    const timeout = setTimeout(fetchQuote, 300);
    return () => clearTimeout(timeout);
  }, [fetchQuote]);

  const estimatedUsdValue = parseFloat(fromAmount || "0") * (rates[fromToken] || 0);

  const handleSwap = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!fromAmount || parseFloat(fromAmount) <= 0) {
      setResult({ success: false, message: "Please enter an amount" });
      return;
    }

    if (fromToken === toToken) {
      setResult({ success: false, message: "Cannot swap same token" });
      return;
    }

    // Show confirmation dialog if swap exceeds the approval threshold
    if (
      securityInfo &&
      estimatedUsdValue >= securityInfo.thresholds.approvalThresholdUsd
    ) {
      setShowApprovalDialog(true);
      return;
    }

    await submitSwap();
  };

  const submitSwap = async () => {
    setShowApprovalDialog(false);
    setLoading(true);
    setResult(null);

    const res = await executeSwapAction(fromToken, toToken, fromAmount);

    if (res.success) {
      setResult({
        success: true,
        message: `Swapped ${parseFloat(res.result.fromAmount).toFixed(4)} ${fromToken} → ${parseFloat(res.result.toAmount).toFixed(4)} ${toToken}`,
        txId: res.result.transactionId,
      });

      // Update balances
      setBalances((prev) => ({
        ...prev,
        [fromToken]: res.result.newFromBalance,
        [toToken]: res.result.newToBalance,
      }));

      // Refresh security info
      const securityRes = await getMySecurityInfo();
      if (securityRes.success) {
        setSecurityInfo({
          rateLimit: securityRes.rateLimit,
          dailyLimit: securityRes.dailyLimit,
          dailyTradeCount: securityRes.dailyTradeCount,
          thresholds: securityRes.thresholds,
        });
      }

      // Clear form
      setFromAmount("");
      setToAmount("");

      // Notify parent to refresh history
      onSwapComplete?.();
    } else {
      setResult({ 
        success: false, 
        message: res.error,
        requiresApproval: res.requiresApproval,
      });

      // If funds were held for approval, refresh balances to reflect the hold
      if (res.requiresApproval) {
        const balancesRes = await getMyBalances();
        if (balancesRes.success) {
          const balanceMap: Record<string, string> = {};
          const heldMap: Record<string, string> = {};
          balancesRes.balances.forEach((b) => {
            balanceMap[b.token_symbol] = b.balance;
            heldMap[b.token_symbol] = b.held;
          });
          setBalances(balanceMap);
          setHeldBalances(heldMap);
        }
      }
    }

    setLoading(false);
  };

  const handleFlip = () => {
    setFromToken(toToken);
    setToToken(fromToken);
    setFromAmount(toAmount);
  };

  const handleMaxClick = () => {
    const balance = balances[fromToken] || "0";
    setFromAmount(parseFloat(balance).toString());
  };

  const fromBalance = parseFloat(balances[fromToken] || "0");
  const fromHeld = parseFloat(heldBalances[fromToken] || "0");
  const toBalance = parseFloat(balances[toToken] || "0");
  const fromTokenInfo = TOKENS.find((t) => t.symbol === fromToken);
  const toTokenInfo = TOKENS.find((t) => t.symbol === toToken);

  if (initialLoading) {
    return (
      <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-8 text-center">
        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="mt-4 text-slate-400">Loading swap interface...</p>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-6 shadow-xl w-full h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <svg
            className="w-5 h-5 text-emerald-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
            />
          </svg>
          PLAT Fiat Swap
        </h2>
        <span className="px-2.5 py-1 text-xs font-medium text-emerald-400 bg-emerald-400/10 rounded-full">
          ⛓️ Live Oracle Rates
        </span>
      </div>

      {/* KYC Required Banner */}
      {kycRequired && kycApproved === false && (
        <div className="mb-4 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-amber-400">KYC Verification Required</p>
              <p className="text-xs text-amber-400/70 mt-1">
                You must complete identity verification before making fiat swaps.
                Please complete KYC through your account settings.
              </p>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSwap} className="space-y-4">
        {/* From Token */}
        <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-700/50">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-slate-400">From</label>
            <div className="text-right">
              <button
                type="button"
                onClick={handleMaxClick}
                className="text-xs text-emerald-400 hover:text-emerald-300"
              >
                Balance: {fromBalance.toFixed(4)}
              </button>
              {fromHeld > 0 && (
                <span className="text-xs text-amber-400/70 ml-2">(Held: {fromHeld.toFixed(4)})</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={fromAmount}
              onChange={(e) => setFromAmount(e.target.value)}
              placeholder="0.00"
              step="any"
              min="0"
              className="flex-1 bg-transparent text-2xl text-white placeholder-slate-500 focus:outline-none"
            />
            <select
              value={fromToken}
              onChange={(e) => setFromToken(e.target.value)}
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {TOKENS.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.flag} {stableTokenDisplayName(t.symbol)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Flip Button */}
        <div className="flex justify-center -my-2 relative z-10">
          <button
            type="button"
            onClick={handleFlip}
            className="p-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-xl transition-colors"
          >
            <svg
              className="w-5 h-5 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
              />
            </svg>
          </button>
        </div>

        {/* To Token */}
        <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-700/50">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-slate-400">To</label>
            <span className="text-xs text-slate-500">
              Balance: {toBalance.toFixed(4)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 text-2xl text-white">
              {quoteLoading ? (
                <span className="text-slate-500">Loading...</span>
              ) : toAmount ? (
                toAmount
              ) : (
                <span className="text-slate-500">0.00</span>
              )}
            </div>
            <select
              value={toToken}
              onChange={(e) => setToToken(e.target.value)}
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {toTokenOptions.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.flag} {stableTokenDisplayName(t.symbol)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Rate Display */}
        {rate && fromToken !== toToken && (
          <div className="p-3 bg-slate-900/30 rounded-lg text-center space-y-1">
            <p className="text-sm text-slate-400">
              1 {fromToken} = {rate.toFixed(6)} {toToken}
            </p>
            {rates[fromToken] && (
              <p className="text-xs text-slate-500">
                {fromTokenInfo?.flag} 1 {fromToken} = ${rates[fromToken]?.toFixed(4)} USD
              </p>
            )}
            {processingFee && (
              <p className="text-xs text-amber-400/80">
                Processing Fee: {processingFee.bps / 100}% (~${parseFloat(processingFee.usd).toFixed(2)} USD)
              </p>
            )}
          </div>
        )}

        {/* Result Message */}
        {result && (
          <div
            className={`p-4 rounded-xl border ${
              result.success
                ? "bg-emerald-500/10 border-emerald-500/20"
                : "bg-red-500/10 border-red-500/20"
            }`}
          >
            <p
              className={`text-sm ${
                result.success 
                  ? "text-emerald-400" 
                  : result.requiresApproval 
                    ? "text-yellow-400"
                    : "text-red-400"
              }`}
            >
              {result.requiresApproval && (
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  {result.message}
                </span>
              )}
              {!result.requiresApproval && result.message}
            </p>
            {result.txId && (
              <p className="text-xs text-slate-500 mt-1 font-mono">
                TX: {result.txId.slice(0, 16)}...
              </p>
            )}
            {result.requiresApproval && (
              <p className="text-xs text-yellow-500/80 mt-1">
                An admin will review your request. You&apos;ll be notified when approved.
              </p>
            )}
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={
            loading ||
            !fromAmount ||
            parseFloat(fromAmount) <= 0 ||
            fromToken === toToken ||
            parseFloat(fromAmount) > fromBalance ||
            (kycRequired && kycApproved === false)
          }
          className="w-full py-3 px-4 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 disabled:from-slate-600 disabled:to-slate-600 text-white font-semibold rounded-xl shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40 disabled:shadow-none transition-all duration-200 flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg
                className="animate-spin w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Swapping...
            </>
          ) : kycApproved === null ? (
            "Loading..."
          ) : kycRequired && !kycApproved ? (
            "KYC Required"
          ) : parseFloat(fromAmount || "0") > fromBalance ? (
            "Insufficient Balance"
          ) : (
            "Swap"
          )}
        </button>
      </form>

      {/* Balances Overview */}
      <div className="mt-6 pt-6 border-t border-slate-700/50">
        <h3 className="text-sm font-medium text-slate-400 mb-3">Your Balances</h3>
        <div className="grid grid-cols-2 gap-2">
          {TOKENS.map((t) => {
            const held = parseFloat(heldBalances[t.symbol] || "0");
            return (
              <div
                key={t.symbol}
                className="p-3 bg-slate-900/30 rounded-lg"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white">
                    {t.flag} {t.symbol}
                  </span>
                  <span className="text-sm text-slate-300 font-mono">
                    {parseFloat(balances[t.symbol] || "0").toFixed(4)}
                  </span>
                </div>
                {held > 0 && (
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-amber-400/70">Held</span>
                    <span className="text-xs text-amber-400 font-mono">
                      {held.toFixed(4)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Security Info */}
      {securityInfo && (
        <div className="mt-4 pt-4 border-t border-slate-700/50">
          <h3 className="text-sm font-medium text-slate-400 mb-3">Limits</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Daily trades</span>
              <span className={`${
                securityInfo.dailyTradeCount.tradesUsed >= securityInfo.dailyTradeCount.maxTrades
                  ? "text-red-400"
                  : "text-slate-300"
              }`}>
                {securityInfo.dailyTradeCount.tradesUsed}/{securityInfo.dailyTradeCount.maxTrades}
              </span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  securityInfo.dailyTradeCount.tradesUsed >= securityInfo.dailyTradeCount.maxTrades
                    ? "bg-red-500"
                    : "bg-gradient-to-r from-emerald-500 to-cyan-500"
                }`}
                style={{
                  width: `${Math.min(100, (securityInfo.dailyTradeCount.tradesUsed / securityInfo.dailyTradeCount.maxTrades) * 100)}%`,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Daily volume</span>
              <span className={`${
                securityInfo.dailyLimit.usedToday >= securityInfo.dailyLimit.limit
                  ? "text-red-400"
                  : "text-slate-300"
              }`}>
                ${securityInfo.dailyLimit.usedToday.toFixed(2)} / ${securityInfo.dailyLimit.limit.toFixed(0)}
              </span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-1.5">
              <div 
                className={`h-1.5 rounded-full transition-all ${
                  securityInfo.dailyLimit.usedToday >= securityInfo.dailyLimit.limit
                    ? "bg-red-500"
                    : "bg-gradient-to-r from-emerald-500 to-cyan-500"
                }`}
                style={{ 
                  width: `${Math.min(100, (securityInfo.dailyLimit.usedToday / securityInfo.dailyLimit.limit) * 100)}%` 
                }}
              />
            </div>
            <p className="text-xs text-slate-500">
              Swaps &ge; ${securityInfo.thresholds.approvalThresholdUsd.toLocaleString()} require admin approval
            </p>
          </div>
        </div>
      )}

      {/* Approval Confirmation Dialog */}
      {showApprovalDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white">Admin Approval Required</h3>
            </div>
            <p className="text-sm text-slate-300 mb-2">
              This swap exceeds the approval threshold and requires admin review.
            </p>
            <p className="text-sm text-amber-400/90 mb-4">
              Your <span className="font-semibold">{parseFloat(fromAmount).toLocaleString()} {fromToken}</span> will
              be held until an admin approves or rejects the request.
            </p>
            <div className="p-3 bg-slate-900/50 rounded-lg mb-5 text-xs text-slate-400 space-y-1">
              <div className="flex justify-between">
                <span>Amount</span>
                <span className="text-slate-300">{parseFloat(fromAmount).toLocaleString()} {fromToken}</span>
              </div>
              <div className="flex justify-between">
                <span>Estimated USD value</span>
                <span className="text-slate-300">${estimatedUsdValue.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Approval threshold</span>
                <span className="text-slate-300">${securityInfo?.thresholds.approvalThresholdUsd.toLocaleString()}</span>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowApprovalDialog(false)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitSwap}
                className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold transition-colors"
              >
                Confirm &amp; Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

