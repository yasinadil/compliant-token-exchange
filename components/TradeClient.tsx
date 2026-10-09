// components/TradeClient.tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getPoolData,
  getSwapQuote,
  getUserTradeInfo,
  executeAMMSwap,
} from "@/app/actions/amm";

interface PoolInfo {
  phase: string;
  reservePLAT: string;
  reserveStable: string;
  spotPrice: string;
  swapFeeBps: number;
  totalVolumeUSD: string;
  totalSwapCount: number;
  accumulatedFeesPLAT: string;
  accumulatedFeesStable: string;
  paused: boolean;
}

interface SwapQuote {
  amountOut: string;
  priceImpactBps: number;
  feeAmount: string;
  effectivePrice: string;
  spotPrice: string;
}

interface TokenBalances {
  tusd: string;
  tglobal: string;
  tusdAllowance: string;
  tglobalAllowance: string;
}

interface KYCStatus {
  kycApproved: boolean;
  kycRequired: boolean;
}

function formatNumber(value: string | number, decimals = 2): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "0.00";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(decimals)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(decimals)}K`;
  return num.toFixed(decimals);
}

function formatBalance(value: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return "0.0000";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export default function TradeClient() {
  // Pool state
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [poolLoading, setPoolLoading] = useState(true);

  // User state
  const [balances, setBalances] = useState<TokenBalances | null>(null);
  const [kyc, setKyc] = useState<KYCStatus | null>(null);
  const [userLoading, setUserLoading] = useState(true);

  // Swap state
  const [isBuying, setIsBuying] = useState(true); // true = buy PLAT with USDX
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50); // 0.5% default
  const [showSlippageSettings, setShowSlippageSettings] = useState(false);

  // Quote state
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Execution state
  const [swapping, setSwapping] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quoteTimeout = useRef<NodeJS.Timeout | null>(null);

  // Load pool data
  const loadPool = useCallback(async () => {
    const result = await getPoolData();
    if (result.success) {
      setPool(result.data);
    }
    setPoolLoading(false);
  }, []);

  // Load user data
  const loadUser = useCallback(async () => {
    const result = await getUserTradeInfo();
    if (result.success) {
      setBalances(result.data.balances);
      setKyc(result.data.kyc);
    }
    setUserLoading(false);
  }, []);

  useEffect(() => {
    loadPool();
    loadUser();
    const interval = setInterval(loadPool, 15000);
    return () => clearInterval(interval);
  }, [loadPool, loadUser]);

  // Fetch quote when amount changes (debounced)
  useEffect(() => {
    if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    setQuote(null);
    setError(null);

    if (!amount || parseFloat(amount) <= 0) return;

    quoteTimeout.current = setTimeout(async () => {
      setQuoteLoading(true);
      // tglobalIn = true means selling PLAT; buying means USDX in (tglobalIn = false)
      const tglobalIn = !isBuying;
      const result = await getSwapQuote(tglobalIn, amount);
      if (result.success) {
        setQuote(result.data);
      } else {
        setError(result.error);
      }
      setQuoteLoading(false);
    }, 400);

    return () => {
      if (quoteTimeout.current) clearTimeout(quoteTimeout.current);
    };
  }, [amount, isBuying]);

  // Execute swap
  const handleSwap = async () => {
    if (!amount || !quote || parseFloat(amount) <= 0) return;

    setSwapping(true);
    setError(null);
    setTxHash(null);

    // Apply slippage to get minAmountOut
    const amountOut = parseFloat(quote.amountOut);
    const minOut = amountOut * (1 - slippageBps / 10000);
    const minOutStr = minOut.toFixed(18);

    const tglobalIn = !isBuying;
    const result = await executeAMMSwap(tglobalIn, amount, minOutStr);

    if (result.success) {
      setTxHash(result.data.txHash);
      setAmount("");
      setQuote(null);
      // Refresh balances and pool
      setTimeout(() => {
        loadUser();
        loadPool();
      }, 3000);
    } else {
      setError(result.error);
    }

    setSwapping(false);
  };

  const toggleDirection = () => {
    setIsBuying(!isBuying);
    setAmount("");
    setQuote(null);
    setError(null);
    setTxHash(null);
  };

  const setMaxAmount = () => {
    if (!balances) return;
    const bal = isBuying ? balances.tusd : balances.tglobal;
    setAmount(bal);
  };

  const inputToken = isBuying ? "USDX" : "PLAT";
  const outputToken = isBuying ? "PLAT" : "USDX";
  const inputBalance = balances ? (isBuying ? balances.tusd : balances.tglobal) : "0";
  const outputBalance = balances ? (isBuying ? balances.tglobal : balances.tusd) : "0";

  const kycPassed = kyc ? (!kyc.kycRequired || kyc.kycApproved) : false;

  const canSwap =
    pool?.phase === "ACTIVE" &&
    !pool?.paused &&
    kycPassed &&
    amount &&
    parseFloat(amount) > 0 &&
    parseFloat(amount) <= parseFloat(inputBalance) &&
    quote &&
    !swapping;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Pool Stats Cards */}
      <div className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="PLAT Price"
          value={pool ? `$${formatNumber(pool.spotPrice, 4)}` : "..."}
          loading={poolLoading}
          accent="emerald"
        />
        <StatCard
          label="Total Liquidity"
          value={
            pool
              ? `$${formatNumber(
                  (parseFloat(pool.reserveStable) * 2).toString()
                )}`
              : "..."
          }
          loading={poolLoading}
          accent="cyan"
        />
        <StatCard
          label="24h Volume"
          value={
            pool ? `$${formatNumber(pool.totalVolumeUSD)}` : "..."
          }
          loading={poolLoading}
          accent="violet"
        />
        <StatCard
          label="Total Trades"
          value={pool ? pool.totalSwapCount.toLocaleString() : "..."}
          loading={poolLoading}
          accent="amber"
        />
      </div>

      {/* Swap Card */}
      <div className="lg:col-span-2">
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-6 shadow-xl">
          {/* Pool Status Banner */}
          {pool && pool.phase !== "ACTIVE" && (
            <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Pool is {pool.phase.toLowerCase()}. Trading is disabled.
            </div>
          )}
          {pool?.paused && pool.phase === "ACTIVE" && (
            <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Trading is temporarily paused.
            </div>
          )}

          {/* KYC Required Banner */}
          {kyc?.kycRequired && !kyc?.kycApproved && (
            <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              KYC verification required. Please complete identity verification before trading.
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-white">Swap</h2>
            <button
              onClick={() => setShowSlippageSettings(!showSlippageSettings)}
              className="p-2 hover:bg-slate-700/50 rounded-lg transition-colors text-slate-400 hover:text-white"
              title="Slippage settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>

          {/* Slippage Settings */}
          {showSlippageSettings && (
            <div className="mb-4 p-4 bg-slate-900/50 rounded-xl border border-slate-700/50">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Slippage Tolerance
              </label>
              <div className="flex items-center gap-2 mt-2">
                {[10, 50, 100, 200].map((bps) => (
                  <button
                    key={bps}
                    onClick={() => setSlippageBps(bps)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      slippageBps === bps
                        ? "bg-emerald-500 text-white"
                        : "bg-slate-700 text-slate-300 hover:bg-slate-600"
                    }`}
                  >
                    {(bps / 100).toFixed(1)}%
                  </button>
                ))}
                <div className="flex items-center gap-1 ml-2">
                  <input
                    type="number"
                    value={(slippageBps / 100).toFixed(1)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0 && v <= 50) {
                        setSlippageBps(Math.round(v * 100));
                      }
                    }}
                    className="w-16 px-2 py-1.5 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    step="0.1"
                    min="0"
                    max="50"
                  />
                  <span className="text-slate-400 text-sm">%</span>
                </div>
              </div>
            </div>
          )}

          {/* You Pay */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mb-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-400">You Pay</span>
              <span className="text-xs text-slate-500">
                Balance: {formatBalance(inputBalance)}{" "}
                <button
                  onClick={setMaxAmount}
                  className="text-emerald-400 hover:text-emerald-300 font-medium ml-1"
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
                placeholder="0.00"
                className="flex-1 bg-transparent text-2xl font-semibold text-white outline-none placeholder-slate-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                min="0"
                step="any"
              />
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 rounded-xl">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    inputToken === "USDX"
                      ? "bg-emerald-500 text-white"
                      : "bg-violet-500 text-white"
                  }`}
                >
                  {inputToken[0]}
                </div>
                <span className="text-white font-medium">{inputToken}</span>
              </div>
            </div>
          </div>

          {/* Direction Toggle */}
          <div className="flex justify-center -my-1 relative z-10">
            <button
              onClick={toggleDirection}
              className="w-10 h-10 bg-slate-700 hover:bg-slate-600 border-4 border-slate-800 rounded-xl flex items-center justify-center transition-all hover:rotate-180 duration-300"
            >
              <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>

          {/* You Receive */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-700/50 p-4 mt-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-slate-400">You Receive</span>
              <span className="text-xs text-slate-500">
                Balance: {formatBalance(outputBalance)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                {quoteLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-slate-500 text-lg">Getting quote...</span>
                  </div>
                ) : (
                  <span className={`text-2xl font-semibold ${quote ? "text-white" : "text-slate-600"}`}>
                    {quote ? formatBalance(quote.amountOut) : "0.00"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-700/50 rounded-xl">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    outputToken === "USDX"
                      ? "bg-emerald-500 text-white"
                      : "bg-violet-500 text-white"
                  }`}
                >
                  {outputToken[0]}
                </div>
                <span className="text-white font-medium">{outputToken}</span>
              </div>
            </div>
          </div>

          {/* Quote Details */}
          {quote && (
            <div className="mt-4 p-4 bg-slate-900/30 rounded-xl space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Rate</span>
                <span className="text-white">
                  1 PLAT = {formatNumber(quote.spotPrice, 4)} USDX
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Effective Price</span>
                <span className="text-white">
                  1 PLAT = {formatNumber(quote.effectivePrice, 4)} USDX
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Price Impact</span>
                <span
                  className={
                    quote.priceImpactBps > 100
                      ? "text-red-400"
                      : quote.priceImpactBps > 50
                        ? "text-amber-400"
                        : "text-emerald-400"
                  }
                >
                  {(quote.priceImpactBps / 100).toFixed(2)}%
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Fee ({pool ? pool.swapFeeBps / 100 : 0.3}%)</span>
                <span className="text-white">
                  {formatNumber(quote.feeAmount, 4)} {inputToken}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Min. Received</span>
                <span className="text-white">
                  {formatBalance(
                    (
                      parseFloat(quote.amountOut) *
                      (1 - slippageBps / 10000)
                    ).toString()
                  )}{" "}
                  {outputToken}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Slippage Tolerance</span>
                <span className="text-white">{(slippageBps / 100).toFixed(1)}%</span>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Success */}
          {txHash && (
            <div className="mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              <p className="font-medium">Swap successful!</p>
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline hover:text-emerald-300 mt-1 inline-block font-mono break-all"
              >
                {txHash}
              </a>
            </div>
          )}

          {/* Swap Button */}
          <button
            onClick={handleSwap}
            disabled={!canSwap}
            className={`w-full mt-4 py-4 rounded-xl font-semibold text-lg transition-all duration-200 ${
              canSwap
                ? "bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40"
                : "bg-slate-700 text-slate-400 cursor-not-allowed"
            }`}
          >
            {swapping ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Swapping...
              </span>
            ) : !kycPassed ? (
              "KYC Required"
            ) : pool?.phase !== "ACTIVE" || pool?.paused ? (
              "Trading Disabled"
            ) : !amount || parseFloat(amount) <= 0 ? (
              "Enter Amount"
            ) : parseFloat(amount) > parseFloat(inputBalance) ? (
              `Insufficient ${inputToken} Balance`
            ) : !quote ? (
              "Getting Quote..."
            ) : (
              `Swap ${inputToken} for ${outputToken}`
            )}
          </button>
        </div>
      </div>

      {/* Sidebar */}
      <div className="space-y-4">
        {/* Wallet Balances */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            Your Balances
          </h3>
          {userLoading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-slate-900/50 rounded-xl">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white">
                    T
                  </div>
                  <span className="text-white font-medium">USDX</span>
                </div>
                <span className="text-white font-mono text-sm">
                  {formatBalance(balances?.tusd || "0")}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-900/50 rounded-xl">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-violet-500 flex items-center justify-center text-xs font-bold text-white">
                    T
                  </div>
                  <span className="text-white font-medium">PLAT</span>
                </div>
                <span className="text-white font-mono text-sm">
                  {formatBalance(balances?.tglobal || "0")}
                </span>
              </div>
              <button
                onClick={() => {
                  setUserLoading(true);
                  loadUser();
                }}
                className="w-full py-2 text-xs text-slate-400 hover:text-white transition-colors"
              >
                Refresh Balances
              </button>
            </div>
          )}
        </div>

        {/* KYC Status */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            KYC Status
          </h3>
          {userLoading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : kyc ? (
            <div className="space-y-3">
              {!kyc.kycRequired ? (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Status</span>
                  <span className="text-sm font-medium text-slate-400">Not Required</span>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Verification</span>
                    <span
                      className={`text-sm font-medium ${
                        kyc.kycApproved ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {kyc.kycApproved ? "Verified" : "Not Verified"}
                    </span>
                  </div>
                  {!kyc.kycApproved && (
                    <p className="text-xs text-amber-400/70">
                      Complete identity verification to start trading.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Failed to load KYC status</p>
          )}
        </div>

        {/* Pool Reserves */}
        <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            Pool Reserves
          </h3>
          {poolLoading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-5 h-5 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : pool ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">PLAT</span>
                <span className="text-sm text-white font-mono">
                  {formatNumber(pool.reservePLAT)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">USDX</span>
                <span className="text-sm text-white font-mono">
                  {formatNumber(pool.reserveStable)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">Fee</span>
                <span className="text-sm text-white">
                  {pool.swapFeeBps / 100}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">Phase</span>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    pool.phase === "ACTIVE"
                      ? "text-emerald-400 bg-emerald-400/10"
                      : pool.phase === "PAUSED"
                        ? "text-amber-400 bg-amber-400/10"
                        : "text-slate-400 bg-slate-400/10"
                  }`}
                >
                  {pool.phase}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Failed to load pool data</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  loading,
  accent,
}: {
  label: string;
  value: string;
  loading: boolean;
  accent: string;
}) {
  const colors: Record<string, string> = {
    emerald: "from-emerald-500/10 to-emerald-600/5 border-emerald-500/20",
    cyan: "from-cyan-500/10 to-cyan-600/5 border-cyan-500/20",
    violet: "from-violet-500/10 to-violet-600/5 border-violet-500/20",
    amber: "from-amber-500/10 to-amber-600/5 border-amber-500/20",
  };

  return (
    <div
      className={`bg-gradient-to-br ${colors[accent]} rounded-2xl border p-4 shadow-lg`}
    >
      <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">
        {label}
      </p>
      {loading ? (
        <div className="h-7 w-24 bg-slate-700/50 rounded animate-pulse" />
      ) : (
        <p className="text-xl font-bold text-white">{value}</p>
      )}
    </div>
  );
}
