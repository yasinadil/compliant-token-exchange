"use client";

import "@/config/appkit";
import { useAppKit } from "@reown/appkit/react";
import { useAccount, useDisconnect } from "wagmi";

export default function ConnectButton() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => open()}
          className="cursor-pointer flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20 transition-colors"
        >
          <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-sm text-emerald-400 font-mono">
            {address.slice(0, 6)}...{address.slice(-4)}
          </span>
        </button>
        <button
          onClick={() => disconnect()}
          className="cursor-pointer text-sm text-[var(--ex-text-muted)] hover:text-[var(--ex-text)] transition-colors px-2 py-1"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => open()}
      className="px-4 py-1.5 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-600 hover:to-cyan-600 text-white font-medium rounded-lg transition-all text-sm shadow-lg shadow-emerald-500/25"
    >
      Connect Wallet
    </button>
  );
}
