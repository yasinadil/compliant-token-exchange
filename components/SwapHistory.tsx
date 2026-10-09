// components/SwapHistory.tsx
"use client";

import { useState, useEffect } from "react";
import { getMySwapHistory } from "@/app/actions/swap";

const TOKEN_FLAGS: Record<string, string> = {
  USDX: "🇺🇸",
  GBPX: "🇬🇧",
  EURX: "🇪🇺",
  BRLX: "🇧🇷",
};

interface SwapTransaction {
  id: number;
  transaction_id: string;
  from_token: string;
  from_amount: string;
  to_token: string;
  to_amount: string;
  effective_rate: string;
  from_usd_rate: string;
  to_usd_rate: string;
  status: string;
  created_at: string;
  from_oracle_source: "chainlink" | "pyth" | null;
  to_oracle_source: "chainlink" | "pyth" | null;
  oracle_block_number: string | null;
}

interface SwapHistoryProps {
  refreshKey?: number;
}

export default function SwapHistory({ refreshKey = 0 }: SwapHistoryProps) {
  const [transactions, setTransactions] = useState<SwapTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    async function loadHistory() {
      setLoading(true);
      const result = await getMySwapHistory(50);
      if (result.success) {
        setTransactions(result.transactions);
      }
      setLoading(false);
    }

    loadHistory();
  }, [refreshKey]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  const formatAmount = (amount: string) => {
    return parseFloat(amount).toFixed(4);
  };

  if (loading) {
    return (
      <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-8 w-full h-full flex items-center justify-center">
        <div className="flex items-center justify-center gap-3">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-slate-400">Loading transaction history...</span>
        </div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 p-8 text-center w-full h-full flex flex-col items-center justify-center">
        <svg
          className="w-12 h-12 text-slate-600 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
          />
        </svg>
        <p className="text-slate-400">No swap transactions yet</p>
        <p className="text-sm text-slate-500 mt-1">
          Your swap history will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-slate-800 to-slate-800/50 rounded-2xl border border-slate-700/50 overflow-hidden flex flex-col w-full h-full">
      <div className="p-6 border-b border-slate-700/50 flex-shrink-0">
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
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Swap History
          <span className="text-sm text-slate-400 font-normal">({transactions.length})</span>
        </h2>
      </div>

      <div className="divide-y divide-slate-700/50 overflow-y-auto flex-1">
        {transactions.map((tx) => (
          <div key={tx.transaction_id} className="group">
            <button
              onClick={() =>
                setExpanded(
                  expanded === tx.transaction_id ? null : tx.transaction_id
                )
              }
              className="w-full p-4 hover:bg-slate-700/20 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Swap Icon */}
                  <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center">
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
                  </div>

                  {/* Swap Details */}
                  <div className="text-left">
                    <p className="text-white font-medium flex items-center gap-2">
                      <span>
                        {TOKEN_FLAGS[tx.from_token]} {formatAmount(tx.from_amount)}{" "}
                        {tx.from_token}
                      </span>
                      <svg
                        className="w-4 h-4 text-slate-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M14 5l7 7m0 0l-7 7m7-7H3"
                        />
                      </svg>
                      <span>
                        {TOKEN_FLAGS[tx.to_token]} {formatAmount(tx.to_amount)}{" "}
                        {tx.to_token}
                      </span>
                    </p>
                    <p className="text-sm text-slate-400">
                      {formatDate(tx.created_at)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                      tx.status === "completed"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : tx.status === "failed"
                        ? "bg-red-500/20 text-red-400"
                        : "bg-yellow-500/20 text-yellow-400"
                    }`}
                  >
                    {tx.status}
                  </span>
                  <svg
                    className={`w-5 h-5 text-slate-500 transition-transform ${
                      expanded === tx.transaction_id ? "rotate-180" : ""
                    }`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </div>
              </div>
            </button>

            {/* Expanded Details */}
            {expanded === tx.transaction_id && (
              <div className="px-4 pb-4 bg-slate-900/30">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-slate-900/50 rounded-xl">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Rate</p>
                    <p className="text-sm text-white font-mono">
                      1 {tx.from_token} = {parseFloat(tx.effective_rate).toFixed(6)}{" "}
                      {tx.to_token}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">
                      {tx.from_token}/USD
                    </p>
                    <p className="text-sm text-white font-mono">
                      ${parseFloat(tx.from_usd_rate).toFixed(4)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">
                      {tx.to_token}/USD
                    </p>
                    <p className="text-sm text-white font-mono">
                      ${parseFloat(tx.to_usd_rate).toFixed(4)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Block #</p>
                    <p className="text-sm text-white font-mono">
                      {tx.oracle_block_number || "N/A"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Oracle</p>
                    <div className="flex gap-1">
                      {tx.from_oracle_source && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          tx.from_oracle_source === "chainlink" 
                            ? "bg-blue-500/20 text-blue-400" 
                            : "bg-purple-500/20 text-purple-400"
                        }`}>
                          {tx.from_oracle_source === "chainlink" ? "⛓️" : "🔮"} {tx.from_oracle_source}
                        </span>
                      )}
                      {tx.to_oracle_source && tx.to_oracle_source !== tx.from_oracle_source && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          tx.to_oracle_source === "chainlink" 
                            ? "bg-blue-500/20 text-blue-400" 
                            : "bg-purple-500/20 text-purple-400"
                        }`}>
                          {tx.to_oracle_source === "chainlink" ? "⛓️" : "🔮"} {tx.to_oracle_source}
                        </span>
                      )}
                      {!tx.from_oracle_source && !tx.to_oracle_source && (
                        <span className="text-xs text-slate-500">N/A</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 p-3 bg-slate-900/50 rounded-lg">
                  <p className="text-xs text-slate-500 mb-1">Transaction ID</p>
                  <p className="text-xs text-slate-300 font-mono break-all">
                    {tx.transaction_id}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

