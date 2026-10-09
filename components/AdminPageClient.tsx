// components/AdminPageClient.tsx
"use client";

import { useState, type ReactNode, Children } from "react";

export default function AdminPageClient({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<"platform" | "contracts">("contracts");
  const childArray = Children.toArray(children);

  return (
    <div>
      {/* Section Switcher — segmented control mirroring Exchange/Staking
          (white track + sliding sky indicator + transparent buttons). */}
      <div
        role="tablist"
        aria-label="Admin section"
        className="relative mb-6 grid w-full max-w-3xl grid-cols-2 gap-[6px] overflow-hidden rounded-[10px] bg-white p-[6px] shadow-sm"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-[6px] left-[6px] rounded-[6px] bg-[#0EA5E9] shadow-sm transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{
            width: "calc((100% - 18px) / 2)",
            transform:
              section === "platform"
                ? "translateX(0)"
                : "translateX(calc(100% + 6px))",
          }}
        />
        {(
          [
            { id: "platform", label: "Platform Admin" },
            { id: "contracts", label: "AMM Contracts" },
          ] as const
        ).map((s) => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSection(s.id)}
              className={
                active
                  ? "relative z-10 flex min-h-[40px] min-w-0 cursor-pointer items-center justify-center rounded-[6px] bg-transparent px-4 text-[14px] font-semibold text-white transition-colors duration-[160ms] ease-out"
                  : "relative z-10 flex min-h-[40px] min-w-0 cursor-pointer items-center justify-center rounded-[6px] bg-transparent px-4 text-[14px] font-semibold text-[#6B7280] transition-colors duration-[160ms] ease-out hover:text-[#4B5563]"
              }
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {section === "platform" && childArray[0]}
      {section === "contracts" && childArray[1]}
    </div>
  );
}
