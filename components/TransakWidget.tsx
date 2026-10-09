"use client";

// components/TransakWidget.tsx
// USDX purchase UI — redirects to a server-generated Transak session URL

import { useState } from "react";

interface TransakWidgetProps {
  widgetUrl: string;
  fiatCurrency?: string;
  onSuccess?: (data: unknown) => void;
  onFailure?: (data: unknown) => void;
  onClose?: () => void;
}

export default function TransakWidget({
  widgetUrl,
  fiatCurrency = "USD",
}: TransakWidgetProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleBuy = () => {
    setIsLoading(true);
    window.open(widgetUrl, "_blank", "noopener");
  };

  const getCurrencySymbol = (currency: string) => {
    const symbols: Record<string, string> = {
      USD: "$",
      EUR: "\u20AC",
      GBP: "\u00A3",
      BRL: "R$",
    };
    return symbols[currency] || currency;
  };

  return (
    <div className="p-8">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 mb-4">
          <span className="text-3xl">💵</span>
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Buy USDX</h2>
        <p className="text-gray-400">Purchase USDX via Transak with card or bank transfer</p>
      </div>

      <div className="p-4 rounded-xl bg-gray-900/50 border border-gray-700/50 mb-6">
        <div className="flex justify-between items-center">
          <span className="text-gray-400">Payment currency</span>
          <span className="text-xl font-bold text-white">{getCurrencySymbol(fiatCurrency)} {fiatCurrency}</span>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          * You can adjust the amount on the Transak payment page
        </p>
      </div>

      <button
        onClick={handleBuy}
        disabled={isLoading}
        className={`w-full py-4 rounded-xl font-bold text-lg transition-all ${
          !isLoading
            ? "bg-emerald-500 hover:bg-emerald-600 text-white"
            : "bg-gray-700 text-gray-400 cursor-not-allowed"
        }`}
      >
        {isLoading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Opening Transak...
          </span>
        ) : (
          "Buy USDX with Transak"
        )}
      </button>

      <div className="mt-6 pt-6 border-t border-gray-700/50">
        <p className="text-xs text-gray-500 text-center mb-3">Accepted payment methods</p>
        <div className="flex justify-center gap-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50">
            <span>💳</span>
            <span className="text-sm text-gray-400">Card</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50">
            <span>🏦</span>
            <span className="text-sm text-gray-400">Bank</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50">
            <span>📱</span>
            <span className="text-sm text-gray-400">Apple Pay</span>
          </div>
        </div>
      </div>

      <div className="mt-6 text-center">
        <p className="text-xs text-gray-500">
          Secure payment powered by Transak
        </p>
      </div>
    </div>
  );
}
