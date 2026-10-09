// components/SwapPageClient.tsx
"use client";

import { useState, useCallback } from "react";
import TFiatSwap from "@/components/TFiatSwap";
import SwapHistory from "@/components/SwapHistory";

export default function SwapPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSwapComplete = useCallback(() => {
    // Increment refresh key to trigger history reload
    setRefreshKey((prev) => prev + 1);
  }, []);

  return (
    <div className="grid lg:grid-cols-2 gap-8 items-stretch">
      {/* Swap Widget */}
      <div className="flex">
        <TFiatSwap onSwapComplete={handleSwapComplete} />
      </div>

      {/* Swap History */}
      <div className="flex">
        <SwapHistory refreshKey={refreshKey} />
      </div>
    </div>
  );
}
