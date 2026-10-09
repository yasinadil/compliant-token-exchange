// components/GaslessTransfer.tsx
"use client";

import { useState, useEffect } from "react";
import {
  transferTokensGasless,
  getMySmartAccountAddress,
  getMyTokenBalance,
} from "@/app/actions/gasless";

interface GaslessTransferProps {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
}

export default function GaslessTransfer({
  tokenAddress = "",
  tokenSymbol = "TOKEN",
  tokenDecimals = 18,
}: GaslessTransferProps) {
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    txHash?: string;
  } | null>(null);
  const [smartAccountAddress, setSmartAccountAddress] = useState<string | null>(
    null
  );
  const [balance, setBalance] = useState<string | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(true);

  useEffect(() => {
    async function fetchWalletInfo() {
      setLoadingWallet(true);

      const addressRes = await getMySmartAccountAddress();
      if (addressRes.success) {
        setSmartAccountAddress(addressRes.address);

        if (tokenAddress) {
          const balanceRes = await getMyTokenBalance(
            tokenAddress,
            tokenDecimals
          );
          if (balanceRes.success) {
            setBalance(balanceRes.balance);
          }
        }
      }

      setLoadingWallet(false);
    }
    fetchWalletInfo();
  }, [tokenAddress, tokenDecimals]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!tokenAddress) {
      setResult({ success: false, message: "Token address not configured" });
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const res = await transferTokensGasless(
        tokenAddress,
        toAddress,
        amount,
        tokenDecimals
      );

      if (res.success) {
        setResult({
          success: true,
          message: "Transaction confirmed!",
          txHash: res.txHash,
        });
        setToAddress("");
        setAmount("");

        if (tokenAddress) {
          const balanceRes = await getMyTokenBalance(
            tokenAddress,
            tokenDecimals
          );
          if (balanceRes.success) {
            setBalance(balanceRes.balance);
          }
        }
      } else {
        setResult({ success: false, message: res.error });
      }
    } catch (error) {
      setResult({
        success: false,
        message: error instanceof Error ? error.message : "Transfer failed",
      });
    } finally {
      setLoading(false);
    }
  };

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return (
    <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-6 shadow-xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <svg
            className="w-5 h-5 text-yellow-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          Gasless Transfer
        </h2>
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 text-xs font-medium text-blue-400 bg-blue-400/10 rounded-full">
            Base
          </span>
          <span className="px-2.5 py-1 text-xs font-medium text-yellow-400 bg-yellow-400/10 rounded-full">
            Pimlico
          </span>
        </div>
      </div>

      {/* Smart Account Info */}
      <div className="mb-6 p-4 bg-slate-900/50 rounded-xl border border-slate-700/50">
        <div className="flex justify-between items-start">
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Smart Account
            </label>
            {loadingWallet ? (
              <div className="mt-2 flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-slate-400">Loading...</span>
              </div>
            ) : smartAccountAddress ? (
              <p className="mt-1 text-sm text-yellow-400 font-mono">
                {truncateAddress(smartAccountAddress)}
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">Not available</p>
            )}
          </div>
          {balance !== null && (
            <div className="text-right">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Balance
              </label>
              <p className="mt-1 text-sm text-white font-medium">
                {parseFloat(balance).toFixed(4)} {tokenSymbol}
              </p>
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Recipient Address */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Recipient Address
          </label>
          <input
            type="text"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
            placeholder="0x..."
            required
            pattern="^0x[a-fA-F0-9]{40}$"
            className="w-full px-4 py-3 bg-slate-900/50 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500"
          />
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Amount ({tokenSymbol})
          </label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            required
            min="0"
            step="any"
            className="w-full px-4 py-3 bg-slate-900/50 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500"
          />
        </div>

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
                result.success ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {result.message}
            </p>
            {result.txHash && (
              <a
                href={`https://basescan.org/tx/${result.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
              >
                View on BaseScan
                <svg
                  className="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            )}
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading || !smartAccountAddress || !tokenAddress}
          className="w-full py-3 px-4 bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-600 hover:to-amber-600 disabled:from-slate-600 disabled:to-slate-600 text-white font-semibold rounded-xl shadow-lg shadow-yellow-500/25 hover:shadow-yellow-500/40 disabled:shadow-none transition-all duration-200 flex items-center justify-center gap-2"
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
              Processing...
            </>
          ) : (
            <>
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              Send Gasless
            </>
          )}
        </button>
      </form>
    </div>
  );
}
