"use client";

import { createAppKit } from "@reown/appkit/react";
import { wagmiAdapter, projectId } from "@/config/wagmi";
import { base } from "@reown/appkit/networks";

let initialized = false;

export function ensureAppKitInit() {
  if (initialized || !projectId) return;
  initialized = true;

  createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks: [base],
    defaultNetwork: base,
    metadata: {
      name: "Exchange Admin",
      description: "Exchange AMM Admin Panel",
      url: typeof window !== "undefined" ? window.location.origin : "",
      icons: [],
    },
    themeMode: "dark",
    features: {
      analytics: false,
    },
  });
}

// Auto-initialize on module load
ensureAppKitInit();
