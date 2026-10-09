// components/AMMAdminPanel.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useWriteContract, useSwitchChain } from "wagmi";
import { parseUnits, encodeFunctionData, maxUint256 } from "viem";
import { SkeletonBlock } from "@/components/Skeletons";
import {
  getContractReadData,
  getAdminRolesForAddress,
  checkAddressCompliance,
} from "@/app/actions/amm-admin";
import { addresses } from "@/config/addresses";
import { AMM_ABI } from "@/config/ABI/AMM_ABI";
import { COMPLIANCE_REGISTRY_ABI } from "@/config/ABI/COMPLIANCE_REGISTRY_ABI";
import { IMPACT_POLICY_ABI } from "@/config/ABI/IMPACT_POLICY_ABI";
import { TIME_LOCK_ABI } from "@/config/ABI/TIME_LOCK_ABI";

type Tab =
  | "overview"
  | "controls"
  | "compliance"
  | "impact"
  | "timelock"
  | "fees";

const BASE_CHAIN_ID = 8453;

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
  k: string;
}

interface ImpactPolicyInfo {
  paused: boolean;
  tier0MaxSlippage: number;
  tier1MaxSlippage: number;
  tier2MaxSlippage: number;
  tier3MaxSlippage: number;
  tier1Threshold: string;
  tier2Threshold: string;
  tier3Threshold: string;
}

interface TimelockOperation {
  id: string;
  target: string;
  value: string;
  data: string;
  queuedAt: number;
  executeAfter: number;
  status: number;
  description: string;
}

interface TimelockInfo {
  delay: number;
  minDelay: number;
  maxDelay: number;
  gracePeriod: number;
  operationCount: number;
  pendingOperations: TimelockOperation[];
}

interface AdminRoles {
  isAMMAdmin: boolean;
  isTreasury: boolean;
  isOperator: boolean;
  isProposer: boolean;
  isExecutor: boolean;
  isCanceller: boolean;
  isComplianceOfficer: boolean;
}

interface ComplianceInfo {
  isCompliant: boolean;
  tier: number;
  dailyLimit: string;
  remainingDailyLimit: string;
}

function formatNum(value: string | number, decimals = 2): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "0";
  // Pinned to en-US (comma thousands + dot decimal) so admin figures read
  // unambiguously, regardless of the server/browser locale.
  return num.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function formatDuration(seconds: number): string {
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Compact USD label for impact policy bands (threshold strings from formatUnits, 18 dec). */
function fmtImpactUsd(s: string): string {
  const n = parseFloat(s);
  if (isNaN(n)) return s;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const OP_STATUS_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "None", color: "text-[var(--ex-text-muted)]" },
  1: { label: "Queued", color: "text-amber-600" },
  2: { label: "Executed", color: "text-emerald-600" },
  3: { label: "Cancelled", color: "text-red-600" },
};

export default function AMMAdminPanel() {
  const { address: connectedAddress, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync, isPending: txPending } = useWriteContract();

  const isCorrectChain = chainId === BASE_CHAIN_ID;

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [impactPolicy, setImpactPolicy] = useState<ImpactPolicyInfo | null>(
    null
  );
  const [timelock, setTimelock] = useState<TimelockInfo | null>(null);
  const [roles, setRoles] = useState<AdminRoles | null>(null);
  const [rolesLoading, setRolesLoading] = useState(false);

  // Form states
  const [newFeeBps, setNewFeeBps] = useState("");
  const [feeCollectAddr, setFeeCollectAddr] = useState("");

  const [complianceCheckAddr, setComplianceCheckAddr] = useState("");
  const [complianceResult, setComplianceResult] =
    useState<ComplianceInfo | null>(null);
  const [setTierAddr, setSetTierAddr] = useState("");
  const [setTierValue, setSetTierValue] = useState("1");
  const [batchAddresses, setBatchAddresses] = useState("");
  const [batchTier, setBatchTier] = useState("1");

  const [slipT0, setSlipT0] = useState("");
  const [slipT1, setSlipT1] = useState("");
  const [slipT2, setSlipT2] = useState("");
  const [slipT3, setSlipT3] = useState("");

  const [tierTh1, setTierTh1] = useState("");
  const [tierTh2, setTierTh2] = useState("");
  const [tierTh3, setTierTh3] = useState("");

  const [tlOpType, setTlOpType] = useState<
    "addLiquidity" | "removeLiquidity" | "rebalance"
  >("addLiquidity");
  const [tlTglobalAmt, setTlTglobalAmt] = useState("");
  const [tlTusdAmt, setTlTusdAmt] = useState("");
  const [tlToAddr, setTlToAddr] = useState("");
  const [tlRebalToken, setTlRebalToken] = useState("USDX");
  const [tlRebalAmt, setTlRebalAmt] = useState("");
  const [tlDescription, setTlDescription] = useState("");

  const [tlApproveToken, setTlApproveToken] = useState<"USDX" | "PLAT">(
    "USDX"
  );
  const [tlApproveUnlimited, setTlApproveUnlimited] = useState(true);
  const [tlApproveAmt, setTlApproveAmt] = useState("");
  const [tlApproveDescription, setTlApproveDescription] = useState("");

  // Load contract read data (server-side)
  const loadData = useCallback(async () => {
    setLoading(true);
    const result = await getContractReadData();
    if (result.success) {
      setPool(result.data.pool);
      setImpactPolicy(result.data.impactPolicy);
      setTimelock(result.data.timelock);

      setSlipT0(result.data.impactPolicy.tier0MaxSlippage.toString());
      setSlipT1(result.data.impactPolicy.tier1MaxSlippage.toString());
      setSlipT2(result.data.impactPolicy.tier2MaxSlippage.toString());
      setSlipT3(result.data.impactPolicy.tier3MaxSlippage.toString());
      setTierTh1(result.data.impactPolicy.tier1Threshold);
      setTierTh2(result.data.impactPolicy.tier2Threshold);
      setTierTh3(result.data.impactPolicy.tier3Threshold);
    } else {
      setMessage({ type: "error", text: result.error });
    }
    setLoading(false);
  }, []);

  // Load roles for connected wallet
  const loadRoles = useCallback(async () => {
    if (!connectedAddress) {
      setRoles(null);
      return;
    }
    setRolesLoading(true);
    const result = await getAdminRolesForAddress(connectedAddress);
    if (result.success) {
      setRoles(result.data);
    }
    setRolesLoading(false);
  }, [connectedAddress]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const showMsg = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 8000);
  };

  async function copyAddress(label: string, addr: string) {
    try {
      await navigator.clipboard.writeText(addr);
      showMsg("success", `${label} address copied to clipboard.`);
    } catch {
      showMsg("error", "Could not copy to clipboard.");
    }
  }

  // Wrapper for all write operations via connected wallet
  async function execWrite(
    config: {
      address: `0x${string}`;
      abi: any;
      functionName: string;
      args: any[];
    },
    successMsg: string
  ) {
    if (!isConnected) {
      showMsg("error", "Connect your wallet first.");
      return;
    }
    if (!isCorrectChain) {
      showMsg("error", "Please switch to Base network.");
      return;
    }
    setMessage(null);
    try {
      const hash = await writeContractAsync(config);
      showMsg("success", `${successMsg} TX: ${hash}`);
      setTimeout(loadData, 4000);
    } catch (err: any) {
      const msg =
        err?.shortMessage || err?.message || "Transaction failed";
      showMsg("error", msg);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "controls", label: "Controls" },
    { id: "compliance", label: "Compliance" },
    { id: "impact", label: "Impact Policy" },
    { id: "timelock", label: "Timelock" },
    { id: "fees", label: "Fees" },
  ];

  return (
    <div className="space-y-6">
      {/* Message */}
      {message && (
        <div
          className={`p-4 rounded-xl border text-sm break-all ${
            message.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600"
              : "bg-red-500/10 border-red-500/20 text-red-600"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Wallet & Chain Status */}
      {!isConnected && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 text-sm flex items-center gap-2">
          <svg
            className="w-5 h-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          Connect your admin wallet using the button in the navbar to execute
          contract operations.
        </div>
      )}

      {isConnected && !isCorrectChain && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg
              className="w-5 h-5 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            Wrong network. Please switch to Base.
          </div>
          <button
            onClick={() => switchChain({ chainId: BASE_CHAIN_ID })}
            className="cursor-pointer px-3 py-1 bg-sky-500 hover:bg-sky-700 text-white text-sm font-medium rounded-md transition-colors"
          >
            Switch to Base
          </button>
        </div>
      )}

      {/* Connected Wallet Roles */}
      {isConnected && connectedAddress && (
        <div className="bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-[var(--ex-text-muted)]">Connected:</span>
            <code className="text-sm text-emerald-600 font-mono">
              {connectedAddress}
            </code>
            {rolesLoading ? (
              <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin ml-auto" />
            ) : (
              <div className="flex flex-wrap gap-1.5 ml-auto">
                {roles &&
                  Object.entries(roles).map(([role, has]) => (
                    <span
                      key={role}
                      className={`px-2 py-0.5 text-sm rounded-full ${
                        has
                          ? "bg-emerald-400/10 text-emerald-600 border border-emerald-400/20"
                          : "bg-slate-100 text-[var(--ex-text-subtle)] border border-[var(--ex-border)]"
                      }`}
                    >
                      {role.replace("is", "")}
                    </span>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`cursor-pointer px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-sky-500 text-white"
                : "bg-[var(--ex-surface-muted)] text-[var(--ex-text-muted)] hover:bg-slate-200 border border-[var(--ex-border)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <AmmContentSkeleton />
      ) : (
      <>
      {/* ========== OVERVIEW TAB ========== */}
      {activeTab === "overview" && pool && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <InfoCard label="Phase" value={pool.phase} />
            <InfoCard
              label="Spot Price"
              value={`$${formatNum(pool.spotPrice, 6)}`}
            />
            <InfoCard
              label="Swap Fee"
              value={`${pool.swapFeeBps / 100}%`}
            />
            <InfoCard
              label="Total Volume"
              value={`$${formatNum(pool.totalVolumeUSD)}`}
            />
            <InfoCard
              label="Total Swaps"
              value={pool.totalSwapCount.toLocaleString()}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)] p-5">
              <h4 className="text-lg font-semibold text-[var(--ex-text)] mb-3">
                Reserves
              </h4>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)] text-sm">PLAT</span>
                  <span className="text-[var(--ex-text)] text-sm font-mono">
                    {formatNum(pool.reservePLAT, 4)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)] text-sm">USDX</span>
                  <span className="text-[var(--ex-text)] text-sm font-mono">
                    {formatNum(pool.reserveStable, 4)}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-[var(--ex-border)]">
                  <span className="text-[var(--ex-text-muted)] text-sm">K (invariant)</span>
                  <span className="text-[var(--ex-text)] text-sm font-mono truncate max-w-[200px]">
                    {pool.k}
                  </span>
                </div>
              </div>
            </div>
            <div className="bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)] p-5">
              <h4 className="text-lg font-semibold text-[var(--ex-text)] mb-3">
                Accumulated Fees
              </h4>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)] text-sm">PLAT Fees</span>
                  <span className="text-[var(--ex-text)] text-sm font-mono">
                    {formatNum(pool.accumulatedFeesPLAT, 6)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)] text-sm">USDX Fees</span>
                  <span className="text-[var(--ex-text)] text-sm font-mono">
                    {formatNum(pool.accumulatedFeesStable, 6)}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-[var(--ex-border)]">
                  <span className="text-[var(--ex-text-muted)] text-sm">Paused</span>
                  <span
                    className={`text-sm font-medium ${pool.paused ? "text-red-600" : "text-emerald-600"}`}
                  >
                    {pool.paused ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)] p-5">
            <h4 className="text-lg font-semibold text-[var(--ex-text)] mb-3">
              Contract Addresses
            </h4>
            <div className="space-y-2 text-sm">
              {Object.entries(addresses).map(([name, addr]) => (
                <div
                  key={name}
                  className="flex justify-between items-center"
                >
                  <span className="text-[var(--ex-text-muted)]">{name}</span>
                  <a
                    href={`https://basescan.org/address/${addr}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-600 hover:text-emerald-700 font-mono text-sm underline underline-offset-2"
                  >
                    {addr.slice(0, 6)}...{addr.slice(-4)}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ========== CONTROLS TAB ========== */}
      {activeTab === "controls" && pool && (
        <div className="space-y-4">
          <Card title="Pool Phase">
            <p className="text-sm text-[var(--ex-text-muted)] mb-4">
              Current:{" "}
              <span className="text-[var(--ex-text)] font-medium">{pool.phase}</span>
              {pool.paused && (
                <span className="text-red-600 ml-2">(PAUSED)</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <ActionButton
                label="Activate"
                disabled={
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  pool.phase !== "SEED"
                }
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.AMM as `0x${string}`,
                      abi: AMM_ABI,
                      functionName: "activate",
                      args: [],
                    },
                    "Pool activated."
                  )
                }
              />
              <ActionButton
                label={pool.paused ? "Unpause" : "Pause"}
                variant={pool.paused ? "success" : "warning"}
                disabled={
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  pool.phase !== "ACTIVE"
                }
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.AMM as `0x${string}`,
                      abi: AMM_ABI,
                      functionName: pool.paused ? "unpause" : "pause",
                      args: [],
                    },
                    pool.paused ? "Pool unpaused." : "Pool paused."
                  )
                }
              />
              <ActionButton
                label="Deprecate"
                variant="danger"
                disabled={
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  pool.phase === "DEPRECATED" ||
                  pool.phase === "UNINITIALIZED"
                }
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.AMM as `0x${string}`,
                      abi: AMM_ABI,
                      functionName: "deprecate",
                      args: [],
                    },
                    "Pool deprecated."
                  )
                }
              />
            </div>
          </Card>

          <Card title="Swap Fee">
            <p className="text-sm text-[var(--ex-text-muted)] mb-3">
              Current:{" "}
              <span className="text-[var(--ex-text)] font-medium">
                {pool.swapFeeBps} bps ({pool.swapFeeBps / 100}%)
              </span>
              <span className="text-[var(--ex-text-subtle)] ml-2">Max: 500 bps (5%)</span>
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                value={newFeeBps}
                onChange={(e) => setNewFeeBps(e.target.value)}
                placeholder="Fee in basis points (e.g. 30 = 0.3%)"
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                min="0"
                max="500"
              />
              <ActionButton
                label="Set Fee"
                disabled={
                  txPending || !isConnected || !isCorrectChain || !newFeeBps
                }
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.AMM as `0x${string}`,
                      abi: AMM_ABI,
                      functionName: "setSwapFee",
                      args: [BigInt(parseInt(newFeeBps))],
                    },
                    "Swap fee updated."
                  )
                }
              />
            </div>
          </Card>
        </div>
      )}

      {/* ========== COMPLIANCE TAB ========== */}
      {activeTab === "compliance" && (
        <div className="space-y-4">
          <Card title="Check Address Compliance">
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={complianceCheckAddr}
                onChange={(e) => setComplianceCheckAddr(e.target.value)}
                placeholder="0x address..."
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
              />
              <ActionButton
                label="Check"
                disabled={!complianceCheckAddr}
                onClick={async () => {
                  const result = await checkAddressCompliance(
                    complianceCheckAddr
                  );
                  if (result.success) {
                    setComplianceResult(result.data);
                  } else {
                    showMsg("error", result.error);
                  }
                }}
              />
            </div>
            {complianceResult && (
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)]">Compliant</span>
                  <span
                    className={
                      complianceResult.isCompliant
                        ? "text-emerald-600"
                        : "text-red-600"
                    }
                  >
                    {complianceResult.isCompliant ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)]">Tier</span>
                  <span className="text-[var(--ex-text)]">{complianceResult.tier}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)]">Daily Limit</span>
                  <span className="text-[var(--ex-text)]">
                    ${formatNum(complianceResult.dailyLimit)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--ex-text-muted)]">Remaining Today</span>
                  <span className="text-[var(--ex-text)]">
                    ${formatNum(complianceResult.remainingDailyLimit)}
                  </span>
                </div>
              </div>
            )}
          </Card>

          <Card title="Set Compliance Tier">
            <div className="flex gap-2">
              <input
                type="text"
                value={setTierAddr}
                onChange={(e) => setSetTierAddr(e.target.value)}
                placeholder="0x address..."
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
              />
              <select
                value={setTierValue}
                onChange={(e) => setSetTierValue(e.target.value)}
                className="px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="0">Tier 0 (Blocked)</option>
                <option value="1">Tier 1 ($10K/day)</option>
                <option value="2">Tier 2 ($100K/day)</option>
                <option value="3">Tier 3 ($1M/day)</option>
              </select>
              <ActionButton
                label="Set Tier"
                disabled={
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  !setTierAddr
                }
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.COMPLIANCE_REGISTRY as `0x${string}`,
                      abi: COMPLIANCE_REGISTRY_ABI,
                      functionName: "setComplianceTier",
                      args: [
                        setTierAddr as `0x${string}`,
                        parseInt(setTierValue),
                      ],
                    },
                    `Compliance tier set to ${setTierValue}.`
                  )
                }
              />
            </div>
          </Card>

          <Card title="Batch Set Compliance Tiers">
            <div className="space-y-3">
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] mb-1 block">
                  Addresses (one per line)
                </label>
                <textarea
                  value={batchAddresses}
                  onChange={(e) => setBatchAddresses(e.target.value)}
                  placeholder={"0xabc...\n0xdef...\n0x123..."}
                  rows={4}
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono resize-none"
                />
              </div>
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-sm text-[var(--ex-text-muted)] mb-1 block">
                    Tier for all
                  </label>
                  <select
                    value={batchTier}
                    onChange={(e) => setBatchTier(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  >
                    <option value="0">Tier 0</option>
                    <option value="1">Tier 1</option>
                    <option value="2">Tier 2</option>
                    <option value="3">Tier 3</option>
                  </select>
                </div>
                <ActionButton
                  label="Batch Set"
                  disabled={
                    txPending ||
                    !isConnected ||
                    !isCorrectChain ||
                    !batchAddresses.trim()
                  }
                  onClick={() => {
                    const addrs = batchAddresses
                      .split("\n")
                      .map((a) => a.trim())
                      .filter(Boolean);
                    const tiers = addrs.map(() => parseInt(batchTier));
                    execWrite(
                      {
                        address:
                          addresses.COMPLIANCE_REGISTRY as `0x${string}`,
                        abi: COMPLIANCE_REGISTRY_ABI,
                        functionName: "batchSetComplianceTier",
                        args: [addrs, tiers],
                      },
                      `Batch set ${addrs.length} addresses to tier ${batchTier}.`
                    );
                  }}
                />
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ========== IMPACT POLICY TAB ========== */}
      {activeTab === "impact" && impactPolicy && (
        <div className="space-y-4">
          <Card title="Current Slippage Limits">
            <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
              Bands follow on-chain thresholds (18-decimal USD notionally). Max
              slippage cap per band:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)] leading-snug">
                  {"< "}
                  {fmtImpactUsd(impactPolicy.tier1Threshold)}
                </p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {impactPolicy.tier0MaxSlippage} bps
                </p>
                <p className="text-sm text-[var(--ex-text-subtle)]">
                  {(impactPolicy.tier0MaxSlippage / 100).toFixed(2)}%
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)] leading-snug">
                  {fmtImpactUsd(impactPolicy.tier1Threshold)} –{" "}
                  {fmtImpactUsd(impactPolicy.tier2Threshold)}
                </p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {impactPolicy.tier1MaxSlippage} bps
                </p>
                <p className="text-sm text-[var(--ex-text-subtle)]">
                  {(impactPolicy.tier1MaxSlippage / 100).toFixed(2)}%
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)] leading-snug">
                  {fmtImpactUsd(impactPolicy.tier2Threshold)} –{" "}
                  {fmtImpactUsd(impactPolicy.tier3Threshold)}
                </p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {impactPolicy.tier2MaxSlippage} bps
                </p>
                <p className="text-sm text-[var(--ex-text-subtle)]">
                  {(impactPolicy.tier2MaxSlippage / 100).toFixed(2)}%
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)] leading-snug">
                  {"≥ "}
                  {fmtImpactUsd(impactPolicy.tier3Threshold)}
                </p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {impactPolicy.tier3MaxSlippage} bps
                </p>
                <p className="text-sm text-[var(--ex-text-subtle)]">
                  {(impactPolicy.tier3MaxSlippage / 100).toFixed(2)}%
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-[var(--ex-text-muted)]">
                Policy Status:{" "}
                <span
                  className={
                    impactPolicy.paused
                      ? "text-red-600"
                      : "text-emerald-600"
                  }
                >
                  {impactPolicy.paused ? "Paused" : "Active"}
                </span>
              </span>
              <ActionButton
                label={
                  impactPolicy.paused ? "Unpause Policy" : "Pause Policy"
                }
                variant={impactPolicy.paused ? "success" : "warning"}
                disabled={txPending || !isConnected || !isCorrectChain}
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.IMPACT_POLICY as `0x${string}`,
                      abi: IMPACT_POLICY_ABI,
                      functionName: "setPaused",
                      args: [!impactPolicy.paused],
                    },
                    impactPolicy.paused
                      ? "Policy unpaused."
                      : "Policy paused."
                  )
                }
              />
            </div>
          </Card>

          <Card title="Update tier thresholds (USD trade value)">
            <p className="text-sm text-[var(--ex-text-muted)] mb-3">
              Sets <code className="text-cyan-700/80">tier1ThresholdUSD</code>,{" "}
              <code className="text-cyan-700/80">tier2ThresholdUSD</code>,{" "}
              <code className="text-cyan-700/80">tier3ThresholdUSD</code> on the
              impact policy. Requires{" "}
              <strong className="text-[var(--ex-text)]">ImpactPolicy owner</strong> wallet.
              Enter amounts in USD (e.g. 1000, 10000, 100000); they are encoded
              with 18 decimals. Must satisfy{" "}
              <strong className="text-[var(--ex-text)]">0 &lt; t1 &lt; t2 &lt; t3</strong>.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  Tier 1 upper bound (USD)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={tierTh1}
                  onChange={(e) => setTierTh1(e.target.value)}
                  placeholder="1000"
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  Tier 2 upper bound (USD)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={tierTh2}
                  onChange={(e) => setTierTh2(e.target.value)}
                  placeholder="10000"
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  Tier 3 upper bound (USD)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={tierTh3}
                  onChange={(e) => setTierTh3(e.target.value)}
                  placeholder="100000"
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
            </div>
            <ActionButton
              label="Update tier thresholds"
              disabled={(() => {
                if (
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  !tierTh1 ||
                  !tierTh2 ||
                  !tierTh3
                ) {
                  return true;
                }
                const t1 = parseFloat(tierTh1);
                const t2 = parseFloat(tierTh2);
                const t3 = parseFloat(tierTh3);
                if (
                  isNaN(t1) ||
                  isNaN(t2) ||
                  isNaN(t3) ||
                  t1 <= 0 ||
                  t2 <= 0 ||
                  t3 <= 0 ||
                  !(t1 < t2 && t2 < t3)
                ) {
                  return true;
                }
                return false;
              })()}
              onClick={() =>
                execWrite(
                  {
                    address: addresses.IMPACT_POLICY as `0x${string}`,
                    abi: IMPACT_POLICY_ABI,
                    functionName: "setTierThresholds",
                    args: [
                      parseUnits(tierTh1, 18),
                      parseUnits(tierTh2, 18),
                      parseUnits(tierTh3, 18),
                    ],
                  },
                  "Tier thresholds updated."
                )
              }
            />
          </Card>

          <Card title="Update Slippage Limits">
            <p className="text-sm text-[var(--ex-text-muted)] mb-3">
              Values in basis points. Must be monotonically decreasing (tier0
              &gt; tier1 &gt; tier2 &gt; tier3). Max 1000 bps (10%). Labels use
              current on-chain band boundaries.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  {`< ${fmtImpactUsd(impactPolicy.tier1Threshold)} (bps)`}
                </label>
                <input
                  type="number"
                  value={slipT0}
                  onChange={(e) => setSlipT0(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  min="0"
                  max="1000"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  {`${fmtImpactUsd(impactPolicy.tier1Threshold)} – ${fmtImpactUsd(impactPolicy.tier2Threshold)} (bps)`}
                </label>
                <input
                  type="number"
                  value={slipT1}
                  onChange={(e) => setSlipT1(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  min="0"
                  max="1000"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  {`${fmtImpactUsd(impactPolicy.tier2Threshold)} – ${fmtImpactUsd(impactPolicy.tier3Threshold)} (bps)`}
                </label>
                <input
                  type="number"
                  value={slipT2}
                  onChange={(e) => setSlipT2(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  min="0"
                  max="1000"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  {`≥ ${fmtImpactUsd(impactPolicy.tier3Threshold)} (bps)`}
                </label>
                <input
                  type="number"
                  value={slipT3}
                  onChange={(e) => setSlipT3(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  min="0"
                  max="1000"
                />
              </div>
            </div>
            <ActionButton
              label="Update Limits"
              disabled={
                txPending ||
                !isConnected ||
                !isCorrectChain ||
                !slipT0 ||
                !slipT1 ||
                !slipT2 ||
                !slipT3
              }
              onClick={() =>
                execWrite(
                  {
                    address: addresses.IMPACT_POLICY as `0x${string}`,
                    abi: IMPACT_POLICY_ABI,
                    functionName: "setSlippageLimits",
                    args: [
                      BigInt(parseInt(slipT0)),
                      BigInt(parseInt(slipT1)),
                      BigInt(parseInt(slipT2)),
                      BigInt(parseInt(slipT3)),
                    ],
                  },
                  "Slippage limits updated."
                )
              }
            />
          </Card>
        </div>
      )}

      {/* ========== TIMELOCK TAB ========== */}
      {activeTab === "timelock" && timelock && (
        <div className="space-y-4">
          <Card title="Timelock Configuration">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)]">Current Delay</p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {formatDuration(timelock.delay)}
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)]">Min Delay</p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {formatDuration(timelock.minDelay)}
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)]">Max Delay</p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {formatDuration(timelock.maxDelay)}
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-3 text-center">
                <p className="text-sm text-[var(--ex-text-muted)]">Grace Period</p>
                <p className="text-lg font-bold text-[var(--ex-text)]">
                  {formatDuration(timelock.gracePeriod)}
                </p>
              </div>
            </div>
            <p className="text-sm text-[var(--ex-text-muted)]">
              Total Operations:{" "}
              <span className="text-[var(--ex-text)]">{timelock.operationCount}</span>
            </p>
          </Card>

          <Card title="Timelock funding & AMM allowance (read this first)">
            <div className="space-y-4 text-sm text-[var(--ex-text)]">
              <p>
                <strong className="text-[var(--ex-text)]">Add liquidity</strong> and{" "}
                <strong className="text-[var(--ex-text)]">rebalance</strong> pull tokens with{" "}
                <code className="text-cyan-700 text-sm">transferFrom</code> where{" "}
                <code className="text-cyan-700 text-sm">msg.sender</code> is the{" "}
                <strong className="text-[var(--ex-text)]">timelock contract</strong> — not your
                admin wallet. You must send tokens to the timelock, then let the
                timelock approve the AMM, then queue the liquidity/rebalance op.
              </p>
              <p className="text-[var(--ex-text-muted)]">
                <strong className="text-[var(--ex-text)]">Remove liquidity</strong> only moves
                pool reserves to your chosen recipient; the timelock does not need
                a token balance or allowance for that path.
              </p>
              <div className="rounded-lg border border-[var(--ex-border)] bg-[var(--ex-surface-muted)] p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ex-text-subtle)]">
                  Suggested order
                </p>
                <ol className="list-decimal list-inside space-y-1 text-[var(--ex-text-muted)]">
                  <li>
                    Transfer PLAT/USDX to the timelock (wallet send / treasury).
                  </li>
                  <li>
                    Queue <strong className="text-[var(--ex-text)]">AMM allowance</strong>{" "}
                    below for each token → wait delay → Execute.
                  </li>
                  <li>
                    Queue add/rebalance → wait delay → Execute.
                  </li>
                </ol>
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[var(--ex-text-subtle)] uppercase tracking-wide">
                  Timelock (send tokens here)
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-sm text-emerald-700 break-all flex-1 min-w-0">
                    {addresses.TIME_LOCK}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyAddress("Timelock", addresses.TIME_LOCK)}
                    className="cursor-pointer shrink-0 px-2 py-1 text-sm rounded-md bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)]"
                  >
                    Copy
                  </button>
                  <a
                    href={`https://basescan.org/address/${addresses.TIME_LOCK}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-sm text-cyan-600 hover:underline"
                  >
                    BaseScan
                  </a>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-sm text-[var(--ex-text-subtle)] mb-1">USDX</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm text-[var(--ex-text-muted)] break-all">
                      {addresses.USDX}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyAddress("USDX", addresses.USDX)}
                      className="cursor-pointer px-2 py-0.5 text-sm rounded bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)]"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-[var(--ex-text-subtle)] mb-1">PLAT</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm text-[var(--ex-text-muted)] break-all">
                      {addresses.PLAT}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        copyAddress("PLAT", addresses.PLAT)
                      }
                      className="cursor-pointer px-2 py-0.5 text-sm rounded bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)]"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Queue AMM allowance (timelock → vault)">
            <p className="text-sm text-[var(--ex-text-muted)] mb-3">
              Queues <code className="text-cyan-700/90 text-sm">token.approve(AMM, amount)</code>{" "}
              with the <strong className="text-[var(--ex-text)]">timelock</strong> as caller.
              Run after funding the timelock; execute this op before the add/rebalance
              op. Each new queue waits the full delay again.
            </p>
            <div className="grid sm:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">Token</label>
                <select
                  value={tlApproveToken}
                  onChange={(e) =>
                    setTlApproveToken(e.target.value as "USDX" | "PLAT")
                  }
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  <option value="USDX">USDX</option>
                  <option value="PLAT">PLAT</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  Allowance
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--ex-text)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tlApproveUnlimited}
                    onChange={(e) => setTlApproveUnlimited(e.target.checked)}
                    className="rounded border-[var(--ex-border-strong)]"
                  />
                  Unlimited (max uint256)
                </label>
                {!tlApproveUnlimited && (
                  <input
                    type="number"
                    value={tlApproveAmt}
                    onChange={(e) => setTlApproveAmt(e.target.value)}
                    placeholder="Token amount (e.g. 10000)"
                    className="mt-2 w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                )}
              </div>
            </div>
            <div className="mb-3">
              <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                Description
              </label>
              <input
                type="text"
                value={tlApproveDescription}
                onChange={(e) => setTlApproveDescription(e.target.value)}
                placeholder="e.g. Approve USDX for vault rebalance"
                className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
            <ActionButton
              label="Queue approval operation"
              disabled={
                txPending ||
                !isConnected ||
                !isCorrectChain ||
                !tlApproveDescription ||
                (!tlApproveUnlimited &&
                  (!tlApproveAmt || parseFloat(tlApproveAmt) <= 0))
              }
              onClick={() => {
                const tokenAddr =
                  tlApproveToken === "USDX"
                    ? addresses.USDX
                    : addresses.PLAT;
                const value = tlApproveUnlimited
                  ? maxUint256
                  : parseUnits(tlApproveAmt || "0", 18);
                const calldata = encodeFunctionData({
                  abi: ERC20_APPROVE_ABI,
                  functionName: "approve",
                  args: [addresses.AMM as `0x${string}`, value],
                });
                execWrite(
                  {
                    address: addresses.TIME_LOCK as `0x${string}`,
                    abi: TIME_LOCK_ABI,
                    functionName: "queue",
                    args: [
                      tokenAddr as `0x${string}`,
                      BigInt(0),
                      calldata,
                      tlApproveDescription,
                    ],
                  },
                  "Allowance operation queued. Execute after delay, then queue liquidity/rebalance."
                );
              }}
            />
          </Card>

          {/* Pending Operations */}
          <Card
            title={`Pending Operations (${timelock.pendingOperations.length})`}
          >
            {timelock.pendingOperations.length === 0 ? (
              <p className="text-sm text-[var(--ex-text-subtle)] py-4 text-center">
                No pending operations
              </p>
            ) : (
              <div className="space-y-3">
                {timelock.pendingOperations.map((op) => {
                  const now = Math.floor(Date.now() / 1000);
                  const isReady = now >= op.executeAfter;
                  const timeLeft = op.executeAfter - now;
                  const statusInfo = OP_STATUS_LABELS[op.status] || {
                    label: "Unknown",
                    color: "text-[var(--ex-text-muted)]",
                  };

                  return (
                    <div
                      key={op.id}
                      className="bg-[var(--ex-surface-muted)] rounded-lg p-4 border border-[var(--ex-border)]"
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-[var(--ex-text)] font-medium truncate">
                            {op.description}
                          </p>
                          <p className="text-sm text-[var(--ex-text-subtle)] font-mono truncate mt-1">
                            ID: {op.id}
                          </p>
                        </div>
                        <span
                          className={`text-sm font-medium ${statusInfo.color}`}
                        >
                          {statusInfo.label}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-4 text-sm text-[var(--ex-text-muted)] mb-3">
                        <span>
                          Queued:{" "}
                          {new Date(op.queuedAt * 1000).toLocaleString()}
                        </span>
                        <span>
                          Execute After:{" "}
                          {new Date(
                            op.executeAfter * 1000
                          ).toLocaleString()}
                          {!isReady &&
                            ` (${formatDuration(timeLeft)} left)`}
                        </span>
                      </div>
                      {op.status === 1 && (
                        <div className="flex gap-2">
                          <ActionButton
                            label="Execute"
                            variant="success"
                            disabled={
                              txPending ||
                              !isConnected ||
                              !isCorrectChain ||
                              !isReady
                            }
                            onClick={() =>
                              execWrite(
                                {
                                  address:
                                    addresses.TIME_LOCK as `0x${string}`,
                                  abi: TIME_LOCK_ABI,
                                  functionName: "execute",
                                  args: [op.id as `0x${string}`],
                                },
                                "Operation executed."
                              )
                            }
                          />
                          <ActionButton
                            label="Cancel"
                            variant="danger"
                            disabled={
                              txPending || !isConnected || !isCorrectChain
                            }
                            onClick={() =>
                              execWrite(
                                {
                                  address:
                                    addresses.TIME_LOCK as `0x${string}`,
                                  abi: TIME_LOCK_ABI,
                                  functionName: "cancel",
                                  args: [op.id as `0x${string}`],
                                },
                                "Operation cancelled."
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Queue New Operation */}
          <Card title="Queue Liquidity Operation">
            {(tlOpType === "addLiquidity" || tlOpType === "rebalance") && (
              <div className="mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-700/90 text-sm">
                Requires a <strong className="text-amber-800">funded timelock</strong>{" "}
                and an executed{" "}
                <strong className="text-amber-800">AMM allowance</strong> queue for
                the token(s) you use. See the cards above — executing only this op
                will revert if the timelock has no balance or allowance.
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  Operation Type
                </label>
                <select
                  value={tlOpType}
                  onChange={(e) => setTlOpType(e.target.value as any)}
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  <option value="addLiquidity">Add Liquidity</option>
                  <option value="removeLiquidity">Remove Liquidity</option>
                  <option value="rebalance">Rebalance</option>
                </select>
              </div>

              {tlOpType !== "rebalance" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                      PLAT Amount
                    </label>
                    <input
                      type="number"
                      value={tlTglobalAmt}
                      onChange={(e) => setTlTglobalAmt(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                      USDX Amount
                    </label>
                    <input
                      type="number"
                      value={tlTusdAmt}
                      onChange={(e) => setTlTusdAmt(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                </div>
              )}

              {tlOpType === "removeLiquidity" && (
                <div>
                  <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                    Recipient Address
                  </label>
                  <input
                    type="text"
                    value={tlToAddr}
                    onChange={(e) => setTlToAddr(e.target.value)}
                    placeholder="0x..."
                    className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
                  />
                </div>
              )}

              {tlOpType === "rebalance" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                      Token
                    </label>
                    <select
                      value={tlRebalToken}
                      onChange={(e) => setTlRebalToken(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                      <option value="USDX">
                        USDX (makes PLAT more expensive)
                      </option>
                      <option value="PLAT">
                        PLAT (makes PLAT cheaper)
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                      Amount
                    </label>
                    <input
                      type="number"
                      value={tlRebalAmt}
                      onChange={(e) => setTlRebalAmt(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="text-sm text-[var(--ex-text-muted)] block mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={tlDescription}
                  onChange={(e) => setTlDescription(e.target.value)}
                  placeholder="e.g. Add 10K liquidity to deepen pool"
                  className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <ActionButton
                label="Queue Operation"
                disabled={
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  !tlDescription
                }
                onClick={() => {
                  let calldata: `0x${string}`;

                  if (tlOpType === "addLiquidity") {
                    calldata = encodeFunctionData({
                      abi: AMM_ABI,
                      functionName: "addLiquidity",
                      args: [
                        parseUnits(tlTglobalAmt || "0", 18),
                        parseUnits(tlTusdAmt || "0", 18),
                      ],
                    });
                  } else if (tlOpType === "removeLiquidity") {
                    calldata = encodeFunctionData({
                      abi: AMM_ABI,
                      functionName: "removeLiquidity",
                      args: [
                        parseUnits(tlTglobalAmt || "0", 18),
                        parseUnits(tlTusdAmt || "0", 18),
                        (tlToAddr || connectedAddress!) as `0x${string}`,
                      ],
                    });
                  } else {
                    const tokenAddr =
                      tlRebalToken === "USDX"
                        ? addresses.USDX
                        : addresses.PLAT;
                    calldata = encodeFunctionData({
                      abi: AMM_ABI,
                      functionName: "rebalance",
                      args: [
                        tokenAddr as `0x${string}`,
                        parseUnits(tlRebalAmt || "0", 18),
                      ],
                    });
                  }

                  execWrite(
                    {
                      address: addresses.TIME_LOCK as `0x${string}`,
                      abi: TIME_LOCK_ABI,
                      functionName: "queue",
                      args: [
                        addresses.AMM as `0x${string}`,
                        BigInt(0),
                        calldata,
                        tlDescription,
                      ],
                    },
                    "Operation queued successfully."
                  );
                }}
              />
            </div>
          </Card>
        </div>
      )}

      {/* ========== FEES TAB ========== */}
      {activeTab === "fees" && pool && (
        <div className="space-y-4">
          <Card title="Accumulated Fees">
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-4 text-center">
                <p className="text-sm text-[var(--ex-text-muted)] mb-1">PLAT Fees</p>
                <p className="text-2xl font-bold text-[var(--ex-text)]">
                  {formatNum(pool.accumulatedFeesPLAT, 6)}
                </p>
              </div>
              <div className="bg-[var(--ex-surface-muted)] rounded-lg p-4 text-center">
                <p className="text-sm text-[var(--ex-text-muted)] mb-1">USDX Fees</p>
                <p className="text-2xl font-bold text-[var(--ex-text)]">
                  {formatNum(pool.accumulatedFeesStable, 6)}
                </p>
              </div>
            </div>
          </Card>

          <Card title="Collect Fees">
            <p className="text-sm text-[var(--ex-text-muted)] mb-3">
              Withdraws accumulated fees to the specified address. Requires
              TREASURY_ROLE.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={feeCollectAddr}
                onChange={(e) => setFeeCollectAddr(e.target.value)}
                placeholder="Recipient address (0x...)"
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 font-mono"
              />
              <ActionButton
                label="Collect Fees"
                disabled={
                  txPending ||
                  !isConnected ||
                  !isCorrectChain ||
                  !feeCollectAddr
                }
                onClick={() =>
                  execWrite(
                    {
                      address: addresses.AMM as `0x${string}`,
                      abi: AMM_ABI,
                      functionName: "collectFees",
                      args: [feeCollectAddr as `0x${string}`],
                    },
                    "Fees collected."
                  )
                }
              />
            </div>
          </Card>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function AmmContentSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[88px]" />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SkeletonBlock className="h-44" />
        <SkeletonBlock className="h-44" />
      </div>
      <SkeletonBlock className="h-48" />
    </div>
  );
}

// ============ REUSABLE COMPONENTS ============

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm p-6">
      <h3 className="text-lg font-semibold text-[var(--ex-text)] mb-4">{title}</h3>
      {children}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)] p-4 text-center">
      <p className="text-xs text-[var(--ex-text-muted)] uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className="text-lg font-bold text-[var(--ex-text)]">{value}</p>
    </div>
  );
}

function ActionButton({
  label,
  disabled = false,
  variant = "primary",
  onClick,
}: {
  label: string;
  disabled?: boolean;
  variant?: "primary" | "success" | "warning" | "danger";
  onClick: () => void;
}) {
  const colors = {
    primary: "bg-sky-500 hover:bg-sky-700",
    success: "bg-emerald-500 hover:bg-emerald-700",
    warning: "bg-amber-500 hover:bg-amber-700",
    danger: "bg-red-600 hover:bg-red-700",
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`cursor-pointer disabled:cursor-not-allowed px-4 py-2 ${colors[variant]} disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors text-sm`}
    >
      {label}
    </button>
  );
}
