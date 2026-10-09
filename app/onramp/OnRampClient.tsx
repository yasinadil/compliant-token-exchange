"use client";

// app/onramp/OnRampClient.tsx
// Client-side on-ramp page component

import { useState } from "react";
import Link from "next/link";
import TransakWidget from "@/components/TransakWidget";
import type { OnRampOrder } from "@/app/lib/transak-service";

interface OnRampClientProps {
  widgetUrl: string;
  orderId: string;
  partnerOrderId: string;
  recentOrders: OnRampOrder[];
  userName: string;
}

type ViewState = "widget" | "success" | "failed";

export default function OnRampClient({
  widgetUrl,
  orderId,
  partnerOrderId,
  recentOrders,
  userName,
}: OnRampClientProps) {
  const [viewState, setViewState] = useState<ViewState>("widget");
  const [successData, setSuccessData] = useState<any>(null);

  const handleSuccess = (data: any) => {
    console.log("[OnRamp] Transaction successful:", data);
    setSuccessData(data);
    setViewState("success");
  };

  const handleFailure = (data: any) => {
    console.log("[OnRamp] Transaction failed:", data);
    setViewState("failed");
  };

  const handleClose = () => {
    console.log("[OnRamp] Widget closed");
  };

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    // Use consistent format to avoid hydration mismatch
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-emerald-400";
      case "processing":
        return "text-yellow-400";
      case "failed":
      case "refunded":
        return "text-red-400";
      default:
        return "text-gray-400";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return "✓";
      case "processing":
        return "⏳";
      case "failed":
        return "✗";
      case "refunded":
        return "↩";
      default:
        return "•";
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* Header */}
      <header className="border-b border-gray-700/50 bg-gray-900/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-400 hover:text-white transition-colors">
              ← Back
            </Link>
            <h1 className="text-xl font-bold text-white">Buy USDX</h1>
          </div>
          <div className="text-sm text-gray-400">
            Welcome, {userName}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2">

            {/* Widget / Success / Failed State */}
            {viewState === "widget" && (
              <div className="rounded-2xl overflow-hidden border border-gray-700/50 bg-gray-800/30">
                <TransakWidget
                  widgetUrl={widgetUrl}
                  onSuccess={handleSuccess}
                  onFailure={handleFailure}
                  onClose={handleClose}
                />
              </div>
            )}

            {viewState === "success" && (
              <div className="rounded-2xl p-8 border border-emerald-500/30 bg-emerald-500/10 text-center">
                <div className="text-6xl mb-4">🎉</div>
                <h2 className="text-2xl font-bold text-white mb-2">
                  Purchase Successful!
                </h2>
                <p className="text-gray-300 mb-6">
                  Your USDX will be credited to your account shortly.
                  This usually takes 1-5 minutes.
                </p>
                <div className="flex gap-4 justify-center">
                  <Link
                    href="/swap"
                    className="px-6 py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-semibold transition-colors"
                  >
                    Go to Swap
                  </Link>
                  <button
                    onClick={() => window.location.reload()}
                    className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl font-semibold transition-colors"
                  >
                    Buy More
                  </button>
                </div>
              </div>
            )}

            {viewState === "failed" && (
              <div className="rounded-2xl p-8 border border-red-500/30 bg-red-500/10 text-center">
                <div className="text-6xl mb-4">😔</div>
                <h2 className="text-2xl font-bold text-white mb-2">
                  Transaction Failed
                </h2>
                <p className="text-gray-300 mb-6">
                  Something went wrong with your purchase. Please try again or contact support.
                </p>
                <div className="flex gap-4 justify-center">
                  <button
                    onClick={() => window.location.reload()}
                    className="px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-semibold transition-colors"
                  >
                    Try Again
                  </button>
                  <Link
                    href="/"
                    className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl font-semibold transition-colors"
                  >
                    Go Home
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* How it works */}
            <div className="rounded-2xl p-6 border border-gray-700/50 bg-gray-800/30">
              <h3 className="text-lg font-semibold text-white mb-4">How it works</h3>
              <ol className="space-y-4">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-sm flex items-center justify-center">
                    1
                  </span>
                  <div>
                    <p className="text-white font-medium">Enter amount</p>
                    <p className="text-sm text-gray-400">Choose how much USDX you want</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-sm flex items-center justify-center">
                    2
                  </span>
                  <div>
                    <p className="text-white font-medium">Complete payment</p>
                    <p className="text-sm text-gray-400">Securely pay with card or bank</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-sm flex items-center justify-center">
                    3
                  </span>
                  <div>
                    <p className="text-white font-medium">Receive USDX</p>
                    <p className="text-sm text-gray-400">Credited to your account instantly</p>
                  </div>
                </li>
              </ol>
            </div>

            {/* Recent Orders */}
            <div className="rounded-2xl p-6 border border-gray-700/50 bg-gray-800/30">
              <h3 className="text-lg font-semibold text-white mb-4">Recent Purchases</h3>
              {recentOrders.length === 0 ? (
                <p className="text-gray-400 text-sm">No recent purchases</p>
              ) : (
                <div className="space-y-3">
                  {recentOrders.map((order) => (
                    <div
                      key={order.id}
                      className="p-3 rounded-lg bg-gray-900/50 border border-gray-700/30"
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-white font-medium">
                          {order.fiat_amount} {order.fiat_currency}
                        </span>
                        <span className={`text-sm ${getStatusColor(order.status)}`}>
                          {getStatusIcon(order.status)} {order.status}
                        </span>
                      </div>
                      <div className="flex justify-between items-end">
                        <span className="text-sm text-emerald-400">
                          → {parseFloat(order.tusd_amount || "0").toFixed(2)} USDX
                        </span>
                        <span className="text-xs text-gray-500">
                          {formatDate(order.created_at)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Order ID */}
            <div className="rounded-2xl p-4 border border-gray-700/50 bg-gray-800/30">
              <p className="text-xs text-gray-500 mb-1">Order Reference</p>
              <p className="text-sm text-gray-400 font-mono break-all">
                {partnerOrderId}
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

