// components/AdminPanel.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useWriteContract, useSwitchChain, useReadContract } from "wagmi";
import { isAddress } from "viem";
import { addresses } from "@/config/addresses";
import { AMM_ABI } from "@/config/ABI/AMM_ABI";
import { STAKING_ABI } from "@/config/ABI/STAKING_ABI";
import {
  getAdminPendingApprovals,
  getAdminPausedUsers,
  adminApproveSwap,
  adminRejectSwap,
  adminPauseUser,
  adminUnpauseUser,
  createCheckoutApiKeyAction,
  listCheckoutApiKeysAction,
  revokeCheckoutApiKeyAction,
  getSwapPlatformSettings,
  updateSwapPlatformSetting,
  getCollectedFeeStats,
  getPlatformOperatorWalletAction,
  generatePlatformOperatorWalletAction,
  rotatePlatformOperatorWalletAction,
  type FeeStats,
} from "@/app/actions/admin";
import { getAdminOperatorInfo } from "@/app/actions/trade-orders";
import {
  getAdminPendingCashouts,
  adminCompleteCashout,
  adminFailCashout,
} from "@/app/actions/cashout";
import { getAdminTransactions } from "@/app/actions/transactions";
import type {
  AdminTransactionRow,
  AdminTransactionListParams,
} from "@/app/lib/admin-transactions-service";
import { useAdminList, type AdminListQuery } from "./admin/useAdminList";
import { AdminListToolbar, AdminListPagination } from "./admin/AdminListToolbar";
import { SkeletonBlock } from "@/components/Skeletons";

interface PendingApproval {
  id: number;
  approval_id: string;
  user_id: string;
  from_token: string;
  from_amount: string;
  to_token: string;
  estimated_to_amount: string;
  usd_value: string;
  status: string;
  created_at: string;
  expires_at: string;
}

interface PausedUser {
  user_id: string;
  pause_reason: string;
  paused_by: string;
  paused_at: string;
}

interface CashoutAdmin {
  cashout_id: string;
  user_id: string;
  token: string;
  token_amount: string;
  tusd_amount: string;
  fiat_currency: string;
  fiat_amount: string;
  status: string;
  bank_details_encrypted: string;
  operator_tx_hash: string | null;
  created_at: string;
}

interface OperatorInfo {
  address: string;
  balances: { tusd: string; tglobal: string };
}

interface PlatformOperatorWallet {
  role: "operator";
  walletAddress: string;
  smartAccountAddress: string;
  createdAt: string | Date;
  rotatedAt: string | Date | null;
}

interface ApiKeyInfo {
  id: number;
  key_id: string;
  name: string;
  permissions: string[];
  is_active: boolean;
  created_by: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
}

const TOKEN_FLAGS: Record<string, string> = {
  USDX: "🇺🇸",
  GBPX: "🇬🇧",
  EURX: "🇪🇺",
  BRLX: "🇧🇷",
};

const CURRENCY_FLAGS: Record<string, string> = {
  USD: "🇺🇸",
  GBP: "🇬🇧",
  EUR: "🇪🇺",
  BRL: "🇧🇷",
};

const CASHOUT_STATUS_COLORS: Record<string, string> = {
  processing: "text-cyan-600 bg-cyan-400/10",
  pending_payout: "text-amber-600 bg-amber-400/10",
  payout_sent: "text-blue-600 bg-blue-400/10",
  awaiting_transak: "text-violet-600 bg-violet-400/10",
  crypto_sent: "text-blue-600 bg-blue-400/10",
  completed: "text-emerald-600 bg-emerald-400/10",
  failed: "text-red-600 bg-red-400/10",
};

/** Status pill colours for the unified transactions feed. Uses the soft
 *  pastel palette from the client "Recent activity" feed (ActivityHistory):
 *  green = done, peach = pending, blue = in-flight, rose = failed, grey =
 *  neutral. Unknown values fall back to neutral grey. */
const TX_STATUS_COLORS: Record<string, string> = {
  completed: "bg-[#EBFFF3] text-[#61BB84]",
  pending: "bg-[#FFF1ED] text-[#FFAA90]",
  pending_payout: "bg-[#FFF1ED] text-[#FFAA90]",
  processing: "bg-sky-50 text-sky-700",
  executing: "bg-sky-50 text-sky-700",
  payout_sent: "bg-sky-50 text-sky-700",
  crypto_sent: "bg-sky-50 text-sky-700",
  awaiting_transak: "bg-violet-50 text-violet-700",
  failed: "bg-rose-100 text-rose-700",
  reversed: "bg-orange-50 text-orange-700",
  refunded: "bg-slate-100 text-slate-600",
};

/** Colored badge + label per transaction type tag. */
const TX_TYPE_BADGES: Record<
  AdminTransactionRow["tx_type"],
  { label: string; className: string }
> = {
  buy: { label: "Buy", className: "text-emerald-600 bg-emerald-400/10" },
  sell: { label: "Sell", className: "text-red-600 bg-red-400/10" },
  convert: { label: "Convert", className: "text-cyan-600 bg-cyan-400/10" },
  deposit: { label: "Deposit", className: "text-blue-600 bg-blue-400/10" },
  withdraw: { label: "Withdraw", className: "text-amber-600 bg-amber-400/10" },
};

/** Activity glyph + circle colour per transaction type — reuses the exact
 *  icons/colours from the client "Recent activity" feed (ActivityHistory). */
const TX_TYPE_ICONS: Record<
  AdminTransactionRow["tx_type"],
  { bg: string; iconSrc: string }
> = {
  buy: { bg: "bg-[#E7EDFF]", iconSrc: "/icons/activitybuy.svg" },
  sell: { bg: "bg-[#DCFAF8]", iconSrc: "/icons/activitysell.svg" },
  convert: { bg: "bg-[#FFF5D9]", iconSrc: "/icons/activityswap.svg" },
  deposit: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitydeposited.svg" },
  withdraw: { bg: "bg-[#FFE0EB]", iconSrc: "/icons/activitycollected.svg" },
};

const ADMIN_TX_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All types" },
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "convert", label: "Convert" },
  { value: "deposit", label: "Deposit" },
  { value: "withdraw", label: "Withdraw" },
];

const ADMIN_TX_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "created_at", label: "Created" },
  { value: "status", label: "Status" },
  { value: "tx_type", label: "Type" },
];

const BASE_CHAIN_ID = 8453;
const AMM_ADDRESS = addresses.AMM as `0x${string}`;
const STAKING_ADDRESS = addresses.STAKING as `0x${string}`;

type AdminTab = "approvals" | "users" | "transactions" | "cashouts" | "operator" | "apikeys" | "swapsettings";

export default function AdminPanel() {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync, isPending: vaultTxPending } = useWriteContract();
  const isCorrectChain = chainId === BASE_CHAIN_ID;

  const [activeTab, setActiveTab] = useState<AdminTab>("approvals");
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [pausedUsers, setPausedUsers] = useState<PausedUser[]>([]);
  const [cashouts, setCashouts] = useState<CashoutAdmin[]>([]);
  const [operatorInfo, setOperatorInfo] = useState<OperatorInfo | null>(null);
  const [platformWallet, setPlatformWallet] =
    useState<PlatformOperatorWallet | null>(null);
  const [platformWalletLoaded, setPlatformWalletLoaded] = useState(false);
  const [rotateConfirm, setRotateConfirm] = useState("");
  const [showRotateModal, setShowRotateModal] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [swapSettings, setSwapSettings] = useState<Record<string, string>>({});
  const [editedSettings, setEditedSettings] = useState<Record<string, string>>({});
  const [feeStats, setFeeStats] = useState<FeeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Pause user form
  const [pauseUserId, setPauseUserId] = useState("");
  const [pauseReason, setPauseReason] = useState("");

  // Rejection notes
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});

  // Cashout form
  const [cashoutRefs, setCashoutRefs] = useState<Record<string, string>>({});
  const [cashoutNotes, setCashoutNotes] = useState<Record<string, string>>({});

  // API key form
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<{ keyId: string; secret: string } | null>(null);

  const { data: operatorRoleHash } = useReadContract({
    address: AMM_ADDRESS,
    abi: AMM_ABI,
    functionName: "OPERATOR_ROLE",
  });

  const operatorAddrValid =
    operatorInfo?.address && isAddress(operatorInfo.address)
      ? (operatorInfo.address as `0x${string}`)
      : undefined;

  const {
    data: hasOperatorRoleOnVault,
    refetch: refetchOperatorRoleOnVault,
    isFetching: operatorRoleCheckLoading,
  } = useReadContract({
    address: AMM_ADDRESS,
    abi: AMM_ABI,
    functionName: "hasRole",
    args:
      operatorRoleHash && operatorAddrValid
        ? [operatorRoleHash, operatorAddrValid]
        : undefined,
    query: {
      enabled: Boolean(operatorRoleHash && operatorAddrValid),
    },
  });

  const { data: stakingOperatorRoleHash } = useReadContract({
    address: STAKING_ADDRESS,
    abi: STAKING_ABI,
    functionName: "OPERATOR_ROLE",
  });

  const {
    data: hasOperatorRoleOnStaking,
    refetch: refetchOperatorRoleOnStaking,
    isFetching: stakingOperatorRoleCheckLoading,
  } = useReadContract({
    address: STAKING_ADDRESS,
    abi: STAKING_ABI,
    functionName: "hasRole",
    args:
      stakingOperatorRoleHash && operatorAddrValid
        ? [stakingOperatorRoleHash as `0x${string}`, operatorAddrValid]
        : undefined,
    query: {
      enabled: Boolean(stakingOperatorRoleHash && operatorAddrValid),
    },
  });

  useEffect(() => {
    loadData();
  }, []);

  const fetchTransactions = useCallback(
    (q: AdminListQuery) => getAdminTransactions(q as AdminTransactionListParams),
    []
  );
  const transactionsList = useAdminList<AdminTransactionRow>(fetchTransactions, {
    active: activeTab === "transactions",
  });

  async function loadData() {
    setLoading(true);
    try {
      const [
        approvalsRes,
        usersRes,
        cashoutsRes,
        opRes,
        keysRes,
        settingsRes,
        feeStatsRes,
        platformWalletRes,
      ] = await Promise.all([
        getAdminPendingApprovals(),
        getAdminPausedUsers(),
        getAdminPendingCashouts(),
        getAdminOperatorInfo(),
        listCheckoutApiKeysAction(),
        getSwapPlatformSettings(),
        getCollectedFeeStats(),
        getPlatformOperatorWalletAction(),
      ]);

      setPlatformWalletLoaded(true);
      if (platformWalletRes.success && platformWalletRes.data) {
        const info = platformWalletRes.data;
        if (info.exists) {
          setPlatformWallet({
            role: info.role,
            walletAddress: info.walletAddress,
            smartAccountAddress: info.smartAccountAddress,
            createdAt: info.createdAt,
            rotatedAt: info.rotatedAt,
          });
        } else {
          setPlatformWallet(null);
        }
      }

      if (approvalsRes.success && approvalsRes.data) {
        setApprovals(approvalsRes.data);
      }
      if (usersRes.success && usersRes.data) {
        setPausedUsers(usersRes.data);
      }
      if (cashoutsRes.success) {
        setCashouts(cashoutsRes.data as CashoutAdmin[]);
      }
      if (opRes.success) {
        setOperatorInfo(opRes.data as OperatorInfo);
      }
      if (keysRes.success && keysRes.data) {
        setApiKeys(keysRes.data as ApiKeyInfo[]);
      }
      if (settingsRes.success && settingsRes.data) {
        setSwapSettings(settingsRes.data);
        setEditedSettings(settingsRes.data);
      }
      if (feeStatsRes.success && feeStatsRes.data) {
        setFeeStats(feeStatsRes.data);
      }
    } catch (error) {
      console.error("Failed to load admin data:", error);
    }
    setLoading(false);
  }

  async function handleGrantVaultOperatorRole() {
    if (!operatorInfo || !operatorRoleHash) return;
    if (!isConnected) {
      setMessage({ type: "error", text: "Connect your wallet first (navbar)." });
      return;
    }
    if (!isCorrectChain) {
      setMessage({ type: "error", text: "Switch to Base mainnet to grant roles on PermissionedAMM." });
      return;
    }
    setMessage(null);
    try {
      const hash = await writeContractAsync({
        address: AMM_ADDRESS,
        abi: AMM_ABI,
        functionName: "grantRole",
        args: [operatorRoleHash, operatorInfo.address as `0x${string}`],
      });
      setMessage({ type: "success", text: `Granted OPERATOR_ROLE on PermissionedAMM for the smart account. TX: ${hash}` });
      setTimeout(() => refetchOperatorRoleOnVault(), 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      setMessage({ type: "error", text: e?.shortMessage || e?.message || "Transaction failed" });
    }
  }

  async function handleRevokeVaultOperatorRole() {
    if (!operatorInfo || !operatorRoleHash) return;
    if (!isConnected) {
      setMessage({ type: "error", text: "Connect your wallet first (navbar)." });
      return;
    }
    if (!isCorrectChain) {
      setMessage({ type: "error", text: "Switch to Base mainnet to revoke roles on PermissionedAMM." });
      return;
    }
    setMessage(null);
    try {
      const hash = await writeContractAsync({
        address: AMM_ADDRESS,
        abi: AMM_ABI,
        functionName: "revokeRole",
        args: [operatorRoleHash, operatorInfo.address as `0x${string}`],
      });
      setMessage({ type: "success", text: `Revoked OPERATOR_ROLE on PermissionedAMM. TX: ${hash}` });
      setTimeout(() => refetchOperatorRoleOnVault(), 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      setMessage({ type: "error", text: e?.shortMessage || e?.message || "Transaction failed" });
    }
  }

  async function handleGrantStakingOperatorRole() {
    if (!operatorInfo || !stakingOperatorRoleHash) return;
    if (!isConnected) {
      setMessage({ type: "error", text: "Connect your wallet first (navbar)." });
      return;
    }
    if (!isCorrectChain) {
      setMessage({
        type: "error",
        text: "Switch to Base mainnet to grant roles on FixedApyStaking.",
      });
      return;
    }
    setMessage(null);
    try {
      const hash = await writeContractAsync({
        address: STAKING_ADDRESS,
        abi: STAKING_ABI,
        functionName: "grantRole",
        args: [
          stakingOperatorRoleHash as `0x${string}`,
          operatorInfo.address as `0x${string}`,
        ],
      });
      setMessage({
        type: "success",
        text: `Granted OPERATOR_ROLE on FixedApyStaking for the smart account. TX: ${hash}`,
      });
      setTimeout(() => refetchOperatorRoleOnStaking(), 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      setMessage({
        type: "error",
        text: e?.shortMessage || e?.message || "Transaction failed",
      });
    }
  }

  async function handleRevokeStakingOperatorRole() {
    if (!operatorInfo || !stakingOperatorRoleHash) return;
    if (!isConnected) {
      setMessage({ type: "error", text: "Connect your wallet first (navbar)." });
      return;
    }
    if (!isCorrectChain) {
      setMessage({
        type: "error",
        text: "Switch to Base mainnet to revoke roles on FixedApyStaking.",
      });
      return;
    }
    setMessage(null);
    try {
      const hash = await writeContractAsync({
        address: STAKING_ADDRESS,
        abi: STAKING_ABI,
        functionName: "revokeRole",
        args: [
          stakingOperatorRoleHash as `0x${string}`,
          operatorInfo.address as `0x${string}`,
        ],
      });
      setMessage({
        type: "success",
        text: `Revoked OPERATOR_ROLE on FixedApyStaking. TX: ${hash}`,
      });
      setTimeout(() => refetchOperatorRoleOnStaking(), 4000);
    } catch (err: unknown) {
      const e = err as { shortMessage?: string; message?: string };
      setMessage({
        type: "error",
        text: e?.shortMessage || e?.message || "Transaction failed",
      });
    }
  }

  async function handleGeneratePlatformWallet() {
    if (platformWallet) return;
    const ok = window.confirm(
      "Generate a fresh operator wallet?\n\n" +
        "After generation you will need to:\n" +
        "  1. Grant OPERATOR_ROLE to the new smart account on PermissionedAMM.\n" +
        "  2. Register the new smart account in ComplianceRegistry.\n" +
        "  3. Fund the new smart account with USDX / PLAT / USDC.\n" +
        "  4. Update PIMLICO_SPONSOR_ALLOWED_SENDERS with the new SA."
    );
    if (!ok) return;

    setActionLoading("platform-wallet-generate");
    setMessage(null);
    try {
      const result = await generatePlatformOperatorWalletAction();
      if (!result.success) {
        setMessage({ type: "error", text: result.error });
        return;
      }
      const info = result.data;
      if (info) {
        setPlatformWallet({
          role: info.role,
          walletAddress: info.walletAddress,
          smartAccountAddress: info.smartAccountAddress,
          createdAt: info.createdAt,
          rotatedAt: info.rotatedAt,
        });
      }
      setMessage({
        type: "success",
        text:
          "Operator wallet generated. Grant OPERATOR_ROLE, register compliance, fund the SA, and update PIMLICO_SPONSOR_ALLOWED_SENDERS.",
      });
      void loadData();
    } catch (e) {
      console.error(e);
      setMessage({ type: "error", text: "Failed to generate operator wallet" });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRotatePlatformWallet() {
    if (rotateConfirm !== "OPERATOR") {
      setMessage({
        type: "error",
        text: 'Type OPERATOR exactly to confirm rotation',
      });
      return;
    }
    setActionLoading("platform-wallet-rotate");
    setMessage(null);
    try {
      const result = await rotatePlatformOperatorWalletAction(rotateConfirm);
      if (!result.success) {
        setMessage({ type: "error", text: result.error });
        return;
      }
      const info = result.data;
      if (info) {
        setPlatformWallet({
          role: info.role,
          walletAddress: info.walletAddress,
          smartAccountAddress: info.smartAccountAddress,
          createdAt: info.createdAt,
          rotatedAt: info.rotatedAt,
        });
      }
      setShowRotateModal(false);
      setRotateConfirm("");
      setMessage({
        type: "success",
        text:
          "Operator wallet rotated. The previous SA still holds funds — sweep them manually. Regrant OPERATOR_ROLE, re-register compliance, refund, and update PIMLICO_SPONSOR_ALLOWED_SENDERS.",
      });
      void loadData();
    } catch (e) {
      console.error(e);
      setMessage({ type: "error", text: "Failed to rotate operator wallet" });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCopyPimlicoSender() {
    if (!platformWallet) return;
    try {
      await navigator.clipboard.writeText(platformWallet.smartAccountAddress);
      setMessage({
        type: "success",
        text: "Smart account address copied — paste into PIMLICO_SPONSOR_ALLOWED_SENDERS.",
      });
    } catch {
      setMessage({ type: "error", text: "Clipboard copy failed" });
    }
  }

  async function handleApprove(approvalId: string) {
    setActionLoading(approvalId);
    setMessage(null);

    const result = await adminApproveSwap(approvalId, "Approved by admin");

    if (result.success) {
      setMessage({ type: "success", text: "Swap approved and executed successfully" });
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }

    setActionLoading(null);
  }

  async function handleReject(approvalId: string) {
    setActionLoading(approvalId);
    setMessage(null);

    const notes = rejectNotes[approvalId] || "Rejected by admin";
    const result = await adminRejectSwap(approvalId, notes);

    if (result.success) {
      setMessage({ type: "success", text: "Swap rejected" });
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }

    setActionLoading(null);
  }

  async function handlePauseUser(e: React.FormEvent) {
    e.preventDefault();
    if (!pauseUserId || !pauseReason) return;

    setActionLoading("pause");
    setMessage(null);

    const result = await adminPauseUser(pauseUserId, pauseReason);

    if (result.success) {
      setMessage({ type: "success", text: `User ${pauseUserId} has been paused` });
      setPauseUserId("");
      setPauseReason("");
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }

    setActionLoading(null);
  }

  async function handleUnpauseUser(userId: string) {
    setActionLoading(userId);
    setMessage(null);

    const result = await adminUnpauseUser(userId);

    if (result.success) {
      setMessage({ type: "success", text: `User ${userId} has been unpaused` });
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }

    setActionLoading(null);
  }

  async function handleCompleteCashout(cashoutId: string) {
    const ref = cashoutRefs[cashoutId];
    if (!ref?.trim()) {
      setMessage({ type: "error", text: "Payment reference is required" });
      return;
    }
    setActionLoading(cashoutId);
    setMessage(null);

    const result = await adminCompleteCashout(cashoutId, ref, cashoutNotes[cashoutId]);
    if (result.success) {
      setMessage({ type: "success", text: "Cashout marked as completed" });
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }
    setActionLoading(null);
  }

  async function handleFailCashout(cashoutId: string) {
    const notes = cashoutNotes[cashoutId];
    if (!notes?.trim()) {
      setMessage({ type: "error", text: "Failure notes are required" });
      return;
    }
    setActionLoading(cashoutId);
    setMessage(null);

    const result = await adminFailCashout(cashoutId, notes);
    if (result.success) {
      setMessage({ type: "success", text: "Cashout marked as failed" });
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }
    setActionLoading(null);
  }

  async function handleCreateApiKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;

    setActionLoading("create-key");
    setMessage(null);
    setCreatedKey(null);

    const result = await createCheckoutApiKeyAction(newKeyName.trim());

    if (!result.success) {
      setMessage({ type: "error", text: result.error });
    } else if (result.data) {
      setCreatedKey(result.data);
      setNewKeyName("");
      setMessage({ type: "success", text: "API key created. Copy the secret now — it will not be shown again." });
      loadData();
    } else {
      setMessage({ type: "error", text: "No key data returned" });
    }

    setActionLoading(null);
  }

  async function handleRevokeApiKey(keyId: string) {
    setActionLoading(keyId);
    setMessage(null);

    const result = await revokeCheckoutApiKeyAction(keyId);

    if (result.success) {
      setMessage({ type: "success", text: `API key ${keyId} revoked` });
      loadData();
    } else {
      setMessage({ type: "error", text: result.error });
    }

    setActionLoading(null);
  }

  const formatDate = (dateInput: string | Date) => {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(dateInput));
  };

  // Token amounts: strip trailing zeros, cap decimals, en-US separators
  // (comma thousands + dot decimal) for unambiguous reading. A tiny non-zero
  // value keeps enough significant digits so it never collapses to "0".
  const formatAmount = (amount: string, maxDecimals = 2) => {
    const n = parseFloat(amount);
    if (!Number.isFinite(n)) return amount;
    if (n === 0) return "0";
    let decimals = maxDecimals;
    if (Math.abs(n) < Math.pow(10, -maxDecimals)) {
      decimals = Math.min(8, Math.ceil(-Math.log10(Math.abs(n))) + 1);
    }
    return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
  };

  // Fiat / USD money: fixed 2 decimals, en-US separators.
  const formatMoney = (amount: string) => {
    const n = parseFloat(amount);
    if (!Number.isFinite(n)) return amount;
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  return (
    <div className="space-y-6">
      {/* Message */}
      {message && (
        <div
          className={`p-4 rounded-xl border ${
            message.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600"
              : "bg-red-500/10 border-red-500/20 text-red-600"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        {([
          { id: "approvals" as AdminTab, label: loading ? "Approvals" : `Approvals (${approvals.length})` },
          { id: "users" as AdminTab, label: loading ? "Paused Users" : `Paused Users (${pausedUsers.length})` },
          {
            id: "transactions" as AdminTab,
            label:
              transactionsList.total !== null
                ? `Transactions (${transactionsList.total})`
                : "Transactions",
          },
          { id: "cashouts" as AdminTab, label: loading ? "Cashouts" : `Cashouts (${cashouts.length})` },
          { id: "operator" as AdminTab, label: "Operator" },
          { id: "apikeys" as AdminTab, label: loading ? "API Keys" : `API Keys (${apiKeys.filter(k => k.is_active).length})` },
          { id: "swapsettings" as AdminTab, label: "Swap Settings" },
        ]).map((tab) => (
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
        <AdminContentSkeleton />
      ) : (
      <>
      {/* Pending Approvals Tab */}
      {activeTab === "approvals" && (
        <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm overflow-hidden">
          <div className="p-6 border-b border-[var(--ex-border)]">
            <h2 className="text-lg font-semibold text-[var(--ex-text)] flex items-center gap-2">
              <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Large Transaction Approvals
              <span className="text-sm text-[var(--ex-text-muted)] font-normal">
                (≥ ${swapSettings.approval_threshold_usd ? parseInt(swapSettings.approval_threshold_usd).toLocaleString("en-US") : "5,000"})
              </span>
            </h2>
          </div>

          {approvals.length === 0 ? (
            <div className="p-8 text-center text-[var(--ex-text-muted)]">
              No pending approvals
            </div>
          ) : (
            <div className="divide-y divide-[var(--ex-border)]">
              {approvals.map((approval) => (
                <div key={approval.approval_id} className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-[var(--ex-text)] font-medium">
                          {TOKEN_FLAGS[approval.from_token]} {formatAmount(approval.from_amount, 4)} {approval.from_token}
                        </span>
                        <svg className="w-4 h-4 text-[var(--ex-text-subtle)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                        </svg>
                        <span className="text-[var(--ex-text)] font-medium">
                          {TOKEN_FLAGS[approval.to_token]} {formatAmount(approval.estimated_to_amount, 4)} {approval.to_token}
                        </span>
                        <span className="px-2 py-0.5 text-xs font-bold text-yellow-600 bg-yellow-400/10 rounded-full">
                          ${formatMoney(approval.usd_value)}
                        </span>
                      </div>
                      <div className="text-sm text-[var(--ex-text-muted)] space-y-1">
                        <p>User: <span className="font-mono text-[var(--ex-text)]">{approval.user_id}</span></p>
                        <p>Requested: {formatDate(approval.created_at)}</p>
                        <p>Expires: {formatDate(approval.expires_at)}</p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => handleApprove(approval.approval_id)}
                        disabled={actionLoading === approval.approval_id}
                        className="px-4 py-2 bg-emerald-500 hover:bg-emerald-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors flex items-center gap-2"
                      >
                        {actionLoading === approval.approval_id ? (
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(approval.approval_id)}
                        disabled={actionLoading === approval.approval_id}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors flex items-center gap-2"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Reject
                      </button>
                    </div>
                  </div>

                  <div className="mt-3">
                    <input
                      type="text"
                      placeholder="Rejection notes (optional)"
                      value={rejectNotes[approval.approval_id] || ""}
                      onChange={(e) =>
                        setRejectNotes((prev) => ({
                          ...prev,
                          [approval.approval_id]: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Users Tab */}
      {activeTab === "users" && (
        <div className="space-y-6">
          {/* Pause User Form */}
          <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm p-6">
            <h3 className=" text-lg font-semibold text-[var(--ex-text)] mb-4">Pause User</h3>
            <form onSubmit={handlePauseUser} className="flex gap-3">
              <input
                type="text"
                placeholder="User ID"
                value={pauseUserId}
                onChange={(e) => setPauseUserId(e.target.value)}
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <input
                type="text"
                placeholder="Reason for pause"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <button
                type="submit"
                disabled={!pauseUserId || !pauseReason || actionLoading === "pause"}
                className="cursor-pointer px-4 py-2 bg-amber-500 hover:bg-amber-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors"
              >
                {actionLoading === "pause" ? "Pausing..." : "Pause User"}
              </button>
            </form>
          </div>

          {/* Paused Users List */}
          <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm overflow-hidden">
            <div className="p-6 border-b border-[var(--ex-border)]">
              <h2 className="text-lg font-semibold text-[var(--ex-text)] flex items-center gap-2">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                Paused Users
              </h2>
            </div>

            {pausedUsers.length === 0 ? (
              <div className="p-8 text-center text-[var(--ex-text-muted)]">
                No paused users
              </div>
            ) : (
              <div className="divide-y divide-[var(--ex-border)]">
                {pausedUsers.map((user) => (
                  <div key={user.user_id} className="p-6 flex items-center justify-between">
                    <div>
                      <p className="text-[var(--ex-text)] font-medium font-mono">{user.user_id}</p>
                      <p className="text-sm text-[var(--ex-text-muted)] mt-1">
                        Reason: <span className="text-red-600">{user.pause_reason}</span>
                      </p>
                      <p className="text-sm text-[var(--ex-text-subtle)] mt-1">
                        Paused by {user.paused_by} on {formatDate(user.paused_at)}
                      </p>
                    </div>
                    <button
                      onClick={() => handleUnpauseUser(user.user_id)}
                      disabled={actionLoading === user.user_id}
                      className="px-4 py-2 bg-emerald-500 hover:bg-emerald-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors"
                    >
                      {actionLoading === user.user_id ? "Unpausing..." : "Unpause"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Trade Orders Tab */}
      {activeTab === "transactions" && (
        <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm overflow-hidden">
          <div className="p-6 border-b border-[var(--ex-border)] space-y-2">
            <h2 className="text-lg font-semibold text-[var(--ex-text)] flex items-center gap-2">
              <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Transactions
            </h2>
            <p className="text-sm text-[var(--ex-text-subtle)]">
              Unified view across Buy, Sell, Convert, Deposit and Withdraw. Date
              filters use calendar days in UTC (<code className="text-[var(--ex-text-muted)]">created_at</code> from 00:00:00 through 23:59:59).
            </p>
          </div>

          <AdminListToolbar
            list={transactionsList}
            statusOptions={ADMIN_TX_TYPE_OPTIONS}
            sortOptions={ADMIN_TX_SORT_OPTIONS}
            filterLabel="Type"
          />

          {transactionsList.loading ? (
            <div className="flex items-center justify-center p-12">
              <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : transactionsList.rows.length === 0 ? (
            <div className="p-8 text-center text-[var(--ex-text-muted)]">
              {transactionsList.total === 0
                ? "No transactions match these filters"
                : "No transactions yet"}
            </div>
          ) : (
            <div className="divide-y divide-[var(--ex-border)]">
              {transactionsList.rows.map((tx) => {
                const badge = TX_TYPE_BADGES[tx.tx_type];
                return (
                  <div key={`${tx.tx_type}-${tx.id}`} className="p-4">
                   <div className="flex gap-3">
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${TX_TYPE_ICONS[tx.tx_type].bg}`}>
                      <img src={TX_TYPE_ICONS[tx.tx_type].iconSrc} alt="" className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-lg font-bold text-[var(--ex-text)]">{badge.label}:</span>
                        {tx.from_label && (
                          <span className="text-lg text-[var(--ex-text)] font-medium">
                            {tx.from_amount ? `${formatAmount(tx.from_amount)} ` : ""}
                            {tx.from_label}
                          </span>
                        )}
                        {tx.from_label && tx.to_label && (
                          <svg className="w-5 h-5 text-[var(--ex-text-subtle)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                        )}
                        {tx.to_label && (
                          <span className="text-lg text-[var(--ex-text)] font-medium">
                            {tx.to_amount ? `${formatAmount(tx.to_amount)} ` : ""}
                            {tx.to_label}
                          </span>
                        )}
                      </div>
                      <span className={`inline-flex shrink-0 items-center justify-center rounded-md px-3.5 py-1.5 text-sm font-medium capitalize ${
                        TX_STATUS_COLORS[tx.status] || "bg-slate-100 text-slate-600"
                      }`}>
                        {tx.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="text-sm text-[var(--ex-text-muted)] space-y-0.5">
                      <p>
                        <span className="font-semibold">User:</span>{" "}
                        {tx.user_email ? (
                          <>
                            <span className="text-[var(--ex-text)]">{tx.user_email}</span>
                            <span className="font-mono text-[var(--ex-text-subtle)]"> · ID {tx.user_id}</span>
                          </>
                        ) : (
                          <span className="font-mono text-[var(--ex-text)]">{tx.user_id}</span>
                        )}
                      </p>
                      <p><span className="font-semibold">Date:</span> {formatDate(tx.created_at)}</p>
                      {tx.tx_hash && (
                        <p><span className="font-semibold">Tx:</span> <a href={`https://basescan.org/tx/${tx.tx_hash}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600/60 hover:text-emerald-600 font-mono underline underline-offset-2">{tx.tx_hash.slice(0, 16)}...</a></p>
                      )}
                      {tx.failure_reason && <p className="text-red-600">Error: {tx.failure_reason}</p>}
                    </div>
                    </div>
                   </div>
                  </div>
                );
              })}
            </div>
          )}

          <AdminListPagination list={transactionsList} />
        </div>
      )}

      {/* Cashouts Tab */}
      {activeTab === "cashouts" && (
        <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm overflow-hidden">
          <div className="p-6 border-b border-[var(--ex-border)] space-y-2">
            <h2 className="text-lg font-semibold text-[var(--ex-text)] flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Cashout Payouts
            </h2>
            <p className="text-sm text-[var(--ex-text-subtle)]">
              Cashouts awaiting operator action. Use Mark Paid / Fail to settle a
              payout. The full off-ramp history lives in the Transactions tab.
            </p>
          </div>

          {cashouts.length === 0 ? (
            <div className="p-8 text-center text-[var(--ex-text-muted)]">
              No cashouts awaiting action
            </div>
          ) : (
            <div className="divide-y divide-[var(--ex-border)]">
              {cashouts.map((cashout) => {
                let bankInfo: Record<string, string> = {};
                try {
                  bankInfo = JSON.parse(cashout.bank_details_encrypted || "{}");
                } catch {}

                return (
                  <div key={cashout.cashout_id} className="p-6">
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[var(--ex-text)] font-semibold">
                            {formatAmount(cashout.token_amount, 4)} {cashout.token}
                          </span>
                          <svg className="w-4 h-4 text-[var(--ex-text-subtle)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                          <span className="text-[var(--ex-text)] font-semibold">
                            {formatMoney(cashout.fiat_amount)} {cashout.fiat_currency}
                          </span>
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${CASHOUT_STATUS_COLORS[cashout.status] || "text-[var(--ex-text-muted)] bg-slate-400/10"}`}>
                            {cashout.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        <div className="text-xs text-[var(--ex-text-muted)] space-y-0.5">
                          <p>User: <span className="font-mono text-[var(--ex-text)]">{cashout.user_id}</span></p>
                          <p>USDX Value: ${formatMoney(cashout.tusd_amount)}</p>
                          <p>Created: {formatDate(cashout.created_at)}</p>
                          {cashout.operator_tx_hash && (
                            <p>AMM Tx: <a href={`https://basescan.org/tx/${cashout.operator_tx_hash}`} target="_blank" rel="noopener noreferrer" className="text-emerald-600/60 hover:text-emerald-600 font-mono underline underline-offset-2">{cashout.operator_tx_hash.slice(0, 16)}...</a></p>
                          )}
                        </div>
                        {Object.keys(bankInfo).length > 0 && (
                          <div className="mt-2 p-2 bg-[var(--ex-surface-muted)] rounded-lg">
                            <p className="text-xs text-[var(--ex-text-subtle)] mb-1">Bank Details:</p>
                            {Object.entries(bankInfo).filter(([, v]) => v).map(([key, val]) => (
                              <p key={key} className="text-xs text-[var(--ex-text)]">
                                <span className="text-[var(--ex-text-subtle)]">{key}:</span> {String(val)}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <button
                          onClick={() => handleCompleteCashout(cashout.cashout_id)}
                          disabled={actionLoading === cashout.cashout_id}
                          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors text-sm"
                        >
                          {actionLoading === cashout.cashout_id ? "..." : "Mark Paid"}
                        </button>
                        <button
                          onClick={() => handleFailCashout(cashout.cashout_id)}
                          disabled={actionLoading === cashout.cashout_id}
                          className="px-4 py-2 bg-red-600 hover:bg-red-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors text-sm"
                        >
                          Fail
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        placeholder="Payment reference (required)"
                        value={cashoutRefs[cashout.cashout_id] || ""}
                        onChange={(e) => setCashoutRefs((prev) => ({ ...prev, [cashout.cashout_id]: e.target.value }))}
                        className="px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      <input
                        type="text"
                        placeholder="Notes (optional)"
                        value={cashoutNotes[cashout.cashout_id] || ""}
                        onChange={(e) => setCashoutNotes((prev) => ({ ...prev, [cashout.cashout_id]: e.target.value }))}
                        className="px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Operator Tab */}
      {activeTab === "operator" && (
        <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm p-6">
          <h2 className="text-lg font-semibold text-[var(--ex-text)] mb-6 flex items-center gap-2">
            <svg className="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Operator Wallet
          </h2>

          {/* Platform Wallet Management (DB-backed) */}
          <div className="mb-6 p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-violet-500/20 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-[var(--ex-text)]">
                  Platform Operator Wallet
                </h3>
                <p className="text-sm text-[var(--ex-text-subtle)] mt-1">
                  Stored encrypted (AES-256-GCM) in the database. The private
                  key never leaves the server and is never displayed anywhere in
                  this UI.
                </p>
              </div>
              {!platformWalletLoaded ? (
                <span className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3.5 py-1.5 text-sm font-medium bg-slate-100 text-slate-600 border border-slate-300">
                  Loading…
                </span>
              ) : platformWallet ? (
                <span className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3.5 py-1.5 text-sm font-medium bg-[#EBFFF3] text-[#61BB84] border border-[#61BB84]/40">
                  Configured
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3.5 py-1.5 text-sm font-medium bg-[#FFF1ED] text-[#FFAA90] border border-[#FFAA90]/60">
                  Not configured
                </span>
              )}
            </div>

            {platformWallet ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="text-sm font-medium text-[var(--ex-text-muted)] uppercase tracking-wider">
                      EOA address
                    </label>
                    <p className="text-sm text-[var(--ex-text)] font-mono break-all mt-0.5">
                      {platformWallet.walletAddress}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[var(--ex-text-muted)] uppercase tracking-wider">
                      Smart account address (Pimlico sponsor sender)
                    </label>
                    <p className="text-sm text-emerald-600 font-mono break-all mt-0.5">
                      {platformWallet.smartAccountAddress}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm text-[var(--ex-text-subtle)]">
                    <div>
                      Created:{" "}
                      <span className="text-[var(--ex-text)]">
                        {new Date(
                          platformWallet.createdAt
                        ).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      Last rotated:{" "}
                      <span className="text-[var(--ex-text)]">
                        {platformWallet.rotatedAt
                          ? new Date(
                              platformWallet.rotatedAt
                            ).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyPimlicoSender()}
                    className="px-3 py-1.5 cursor-pointer bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] rounded-md text-sm transition-colors"
                  >
                    Copy SA for PIMLICO_SPONSOR_ALLOWED_SENDERS
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRotateConfirm("");
                      setShowRotateModal(true);
                    }}
                    className="cursor-pointer disabled:cursor-not-allowed px-3 py-1.5 bg-sky-500 hover:bg-sky-300 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg text-sm transition-colors"
                  >
                    Rotate wallet
                  </button>
                </div>
                <p className="text-sm text-amber-600/80 leading-relaxed">
                  Rotating generates a brand-new key and overwrites the stored
                  one. The previous smart account still holds any funds — you
                  must sweep them manually before or after rotation. You will
                  also need to re-grant OPERATOR_ROLE, re-register compliance,
                  re-fund, and update PIMLICO_SPONSOR_ALLOWED_SENDERS.
                </p>
              </div>
            ) : platformWalletLoaded ? (
              <div className="space-y-3">
                <p className="text-sm text-[var(--ex-text-muted)] leading-relaxed">
                  No operator wallet is configured. Generating one creates a
                  fresh EOA + smart account pair. After generation you must
                  manually complete on-chain setup (PermissionedAMM role, compliance
                  registry, funding) and update PIMLICO_SPONSOR_ALLOWED_SENDERS.
                </p>
                <button
                  type="button"
                  onClick={() => void handleGeneratePlatformWallet()}
                  disabled={actionLoading === "platform-wallet-generate"}
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-md text-sm transition-colors"
                >
                  {actionLoading === "platform-wallet-generate"
                    ? "Generating…"
                    : "Generate operator wallet"}
                </button>
              </div>
            ) : null}
          </div>

          {operatorInfo ? (
            <div className="space-y-4">
              <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
                <label className="text-sm font-medium text-[var(--ex-text-muted)] uppercase tracking-wider">
                  Smart Account Address
                </label>
                <p className="mt-1 text-sm text-emerald-600 font-mono break-all">
                  {operatorInfo.address}
                </p>
                <a
                  href={`https://basescan.org/address/${operatorInfo.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[var(--ex-text-subtle)] hover:text-[var(--ex-text)] mt-1 inline-block underline underline-offset-2"
                >
                  View on BaseScan
                </a>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
                  <label className="text-sm font-medium text-[var(--ex-text-muted)] uppercase tracking-wider">
                    USDX Balance
                  </label>
                  <p className="mt-1 text-xl font-bold text-[var(--ex-text)]">
                    {formatAmount(operatorInfo.balances.tusd, 4)}
                  </p>
                </div>
                <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
                  <label className="text-sm font-medium text-[var(--ex-text-muted)] uppercase tracking-wider">
                    PLAT Balance
                  </label>
                  <p className="mt-1 text-xl font-bold text-[var(--ex-text)]">
                    {formatAmount(operatorInfo.balances.tglobal, 4)}
                  </p>
                </div>
              </div>

              <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-violet-500/20 space-y-3">
                <h3 className="text-lg font-semibold text-[var(--ex-text)]">PermissionedAMM operator role</h3>
                <p className="text-sm text-[var(--ex-text-subtle)]">
                  <code className="text-[var(--ex-text-muted)]">swapOnBehalf</code> requires{" "}
                  <code className="text-[var(--ex-text-muted)]">OPERATOR_ROLE</code> on the pool contract (
                  <a
                    href={`https://basescan.org/address/${AMM_ADDRESS}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-violet-600/80 hover:text-violet-300 underline underline-offset-2"
                  >
                    PermissionedAMM
                  </a>
                  ). Grant it for the smart account above using a wallet that has{" "}
                  <code className="text-[var(--ex-text-muted)]">DEFAULT_ADMIN_ROLE</code> on the vault.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-[var(--ex-text-muted)] uppercase tracking-wider">On-chain status:</span>
                  {operatorRoleCheckLoading ? (
                    <span className="text-sm text-[var(--ex-text-subtle)]">Checking…</span>
                  ) : hasOperatorRoleOnVault ? (
                    <span className="text-sm font-medium text-emerald-600">Has OPERATOR_ROLE</span>
                  ) : (
                    <span className="text-sm font-medium text-amber-600">No OPERATOR_ROLE</span>
                  )}
                </div>
                {!isConnected && (
                  <p className="text-sm text-amber-600/90">
                    Connect your admin wallet (navbar) to submit grant or revoke transactions.
                  </p>
                )}
                {isConnected && !isCorrectChain && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-amber-600/90">Switch to Base to interact with PermissionedAMM.</p>
                    <button
                      type="button"
                      onClick={() => switchChain({ chainId: BASE_CHAIN_ID })}
                      className="cursor-pointer px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-700 rounded-lg text-sm"
                    >
                      Switch to Base
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleGrantVaultOperatorRole()}
                    disabled={
                      vaultTxPending ||
                      !operatorRoleHash ||
                      hasOperatorRoleOnVault === true ||
                      !isConnected ||
                      !isCorrectChain
                    }
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-sky-500 hover:bg-sky-300 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-md transition-colors text-sm"
                  >
                    {vaultTxPending ? "Confirm in wallet…" : "Grant OPERATOR_ROLE"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRevokeVaultOperatorRole()}
                    disabled={
                      vaultTxPending ||
                      !operatorRoleHash ||
                      hasOperatorRoleOnVault !== true ||
                      !isConnected ||
                      !isCorrectChain
                    }
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 disabled:bg-slate-200 disabled:border-slate-300 disabled:text-slate-400 text-[var(--ex-text)] rounded-md transition-colors text-sm"
                  >
                    Revoke OPERATOR_ROLE
                  </button>
                  <button
                    type="button"
                    onClick={() => void refetchOperatorRoleOnVault()}
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 disabled:bg-slate-200 disabled:border-slate-300 disabled:text-slate-400 text-[var(--ex-text)] rounded-md transition-colors text-sm"
                  >
                    Refresh role status
                  </button>
                </div>
              </div>

              <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-emerald-500/20 space-y-3">
                <h3 className="text-lg font-semibold text-[var(--ex-text)]">FixedApyStaking operator role</h3>
                <p className="text-sm text-[var(--ex-text-subtle)]">
                  <code className="text-[var(--ex-text-muted)]">stakeFor</code> /{" "}
                  <code className="text-[var(--ex-text-muted)]">unstakeFor</code> /{" "}
                  <code className="text-[var(--ex-text-muted)]">claimFor</code> require{" "}
                  <code className="text-[var(--ex-text-muted)]">OPERATOR_ROLE</code> on the staking contract (
                  <a
                    href={`https://basescan.org/address/${STAKING_ADDRESS}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-600/80 hover:text-emerald-700 underline underline-offset-2"
                  >
                    FixedApyStaking
                  </a>
                  ). Grant it for the smart account above using a wallet that has{" "}
                  <code className="text-[var(--ex-text-muted)]">DEFAULT_ADMIN_ROLE</code> on the staking contract.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-[var(--ex-text-muted)] uppercase tracking-wider">On-chain status:</span>
                  {stakingOperatorRoleCheckLoading ? (
                    <span className="text-sm text-[var(--ex-text-subtle)]">Checking…</span>
                  ) : hasOperatorRoleOnStaking ? (
                    <span className="text-sm font-medium text-emerald-600">Has OPERATOR_ROLE</span>
                  ) : (
                    <span className="text-sm font-medium text-amber-600">No OPERATOR_ROLE</span>
                  )}
                </div>
                {!isConnected && (
                  <p className="text-sm text-amber-600/90">
                    Connect your admin wallet (navbar) to submit grant or revoke transactions.
                  </p>
                )}
                {isConnected && !isCorrectChain && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-amber-600/90">Switch to Base to interact with FixedApyStaking.</p>
                    <button
                      type="button"
                      onClick={() => switchChain({ chainId: BASE_CHAIN_ID })}
                      className="cursor-pointer px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-700 rounded-lg text-sm"
                    >
                      Switch to Base
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleGrantStakingOperatorRole()}
                    disabled={
                      vaultTxPending ||
                      !stakingOperatorRoleHash ||
                      hasOperatorRoleOnStaking === true ||
                      !isConnected ||
                      !isCorrectChain
                    }
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-sky-500 hover:bg-sky-300 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-md transition-colors text-sm"
                  >
                    {vaultTxPending ? "Confirm in wallet…" : "Grant OPERATOR_ROLE"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRevokeStakingOperatorRole()}
                    disabled={
                      vaultTxPending ||
                      !stakingOperatorRoleHash ||
                      hasOperatorRoleOnStaking !== true ||
                      !isConnected ||
                      !isCorrectChain
                    }
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 disabled:bg-slate-200 disabled:border-slate-300 disabled:text-slate-400 text-[var(--ex-text)] rounded-md transition-colors text-sm"
                  >
                    Revoke OPERATOR_ROLE
                  </button>
                  <button
                    type="button"
                    onClick={() => void refetchOperatorRoleOnStaking()}
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 disabled:bg-slate-200 disabled:border-slate-300 disabled:text-slate-400 text-[var(--ex-text)] rounded-md transition-colors text-sm"
                  >
                    Refresh role status
                  </button>
                </div>
              </div>

              <button
                onClick={loadData}
                className="px-4 py-2 cursor-pointer bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] rounded-md transition-colors text-sm"
              >
                Refresh
              </button>
            </div>
          ) : platformWallet ? (
            <div className="text-center py-6">
              <p className="text-[var(--ex-text-muted)] text-sm">
                Operator smart account is configured but balances / on-chain
                status could not be loaded. Refresh to retry.
              </p>
              <button
                type="button"
                onClick={loadData}
                className="mt-3 px-4 py-2 cursor-pointer bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] rounded-md text-sm transition-colors"
              >
                Refresh
              </button>
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-[var(--ex-text-muted)] text-sm">
                Generate the platform operator wallet above to enable AMM
                trades, staking, and cash-out transfers.
              </p>
            </div>
          )}

          {/* Rotate Confirmation Modal */}
          {showRotateModal && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-white border border-sky-500/40 rounded-2xl p-6 max-w-md w-full space-y-8">
                <h3 className="text-xl font-semibold text-[var(--ex-text)]">
                  Rotate operator wallet?
                </h3>
                <div className="text-base text-[var(--ex-text)] space-y-2">
                  <p>This will:</p>
                  <ul className="list-disc list-inside text-[var(--ex-text-muted)] text-sm space-y-1">
                    <li>
                      Generate a brand-new random private key server-side.
                    </li>
                    <li>
                      Overwrite the currently stored encrypted key (no backup
                      retained).
                    </li>
                    <li>
                      Leave the old smart account&apos;s on-chain funds untouched — you must sweep them manually.
                    </li>
                    <li>
                      Require regranting OPERATOR_ROLE, re-registering
                      compliance, refunding, and updating Pimlico&apos;s allowed
                      senders.
                    </li>
                  </ul>
                </div>
                <div>
                  <label className="text-sm text-[var(--ex-text-muted)]">
                    Type <code className="text-sky-600">OPERATOR</code> to
                    confirm:
                  </label>
                  <input
                    type="text"
                    value={rotateConfirm}
                    onChange={(e) => setRotateConfirm(e.target.value)}
                    autoFocus
                    className="mt-1 w-full px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] text-base focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowRotateModal(false);
                      setRotateConfirm("");
                    }}
                    className="cursor-pointer px-4 py-2 bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] rounded-md text-base"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRotatePlatformWallet()}
                    disabled={
                      rotateConfirm !== "OPERATOR" ||
                      actionLoading === "platform-wallet-rotate"
                    }
                    className="cursor-pointer disabled:cursor-not-allowed px-4 py-2 bg-sky-500 hover:bg-sky-300 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-md text-base"
                  >
                    {actionLoading === "platform-wallet-rotate"
                      ? "Rotating…"
                      : "Rotate"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Swap Settings Tab */}
      {activeTab === "swapsettings" && (
        <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm p-6">
          <h2 className="text-lg font-semibold text-[var(--ex-text)] mb-6 flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
            Fiat Swap Configuration
          </h2>

          <div className="space-y-6">
            {/* Max Trades Per Day */}
            <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
              <label className="block text-sm font-medium text-[var(--ex-text)] mb-1">
                Max Trades Per Day
              </label>
              <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
                Maximum number of fiat swap trades a user can execute per day.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={editedSettings.max_trades_per_day || ""}
                  onChange={(e) =>
                    setEditedSettings((prev) => ({ ...prev, max_trades_per_day: e.target.value }))
                  }
                  className="w-32 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <span className="text-sm text-[var(--ex-text-muted)]">trades / day</span>
                {editedSettings.max_trades_per_day !== swapSettings.max_trades_per_day && (
                  <button
                    onClick={async () => {
                      setActionLoading("setting-max_trades_per_day");
                      const res = await updateSwapPlatformSetting("max_trades_per_day", editedSettings.max_trades_per_day);
                      if (res.success) {
                        setSwapSettings((prev) => ({ ...prev, max_trades_per_day: editedSettings.max_trades_per_day }));
                        setMessage({ type: "success", text: "Max trades per day updated" });
                      } else {
                        setMessage({ type: "error", text: res.error });
                        setEditedSettings((prev) => ({ ...prev, max_trades_per_day: swapSettings.max_trades_per_day }));
                      }
                      setActionLoading(null);
                    }}
                    disabled={actionLoading === "setting-max_trades_per_day"}
                    className="px-3 py-2 bg-sky-500 hover:bg-sky-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-medium rounded-md transition-colors"
                  >
                    {actionLoading === "setting-max_trades_per_day" ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>

            {/* Daily Volume Limit */}
            <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
              <label className="block text-sm font-medium text-[var(--ex-text)] mb-1">
                Daily Volume Limit (USD)
              </label>
              <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
                Maximum total USD value of swaps a user can make per day.
              </p>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ex-text-muted)]">$</span>
                  <input
                    type="number"
                    min="100"
                    step="100"
                    value={editedSettings.daily_volume_limit_usd || ""}
                    onChange={(e) =>
                      setEditedSettings((prev) => ({ ...prev, daily_volume_limit_usd: e.target.value }))
                    }
                    className="w-40 pl-7 pr-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <span className="text-sm text-[var(--ex-text-muted)]">USD / day</span>
                {editedSettings.daily_volume_limit_usd !== swapSettings.daily_volume_limit_usd && (
                  <button
                    onClick={async () => {
                      setActionLoading("setting-daily_volume_limit_usd");
                      const res = await updateSwapPlatformSetting("daily_volume_limit_usd", editedSettings.daily_volume_limit_usd);
                      if (res.success) {
                        setSwapSettings((prev) => ({ ...prev, daily_volume_limit_usd: editedSettings.daily_volume_limit_usd }));
                        setMessage({ type: "success", text: "Daily volume limit updated" });
                      } else {
                        setMessage({ type: "error", text: res.error });
                        setEditedSettings((prev) => ({ ...prev, daily_volume_limit_usd: swapSettings.daily_volume_limit_usd }));
                      }
                      setActionLoading(null);
                    }}
                    disabled={actionLoading === "setting-daily_volume_limit_usd"}
                    className="px-3 py-2 bg-sky-500 hover:bg-sky-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-medium rounded-md transition-colors"
                  >
                    {actionLoading === "setting-daily_volume_limit_usd" ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>

            {/* Approval Threshold */}
            <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
              <label className="block text-sm font-medium text-[var(--ex-text)] mb-1">
                Approval Threshold (USD)
              </label>
              <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
                Swap value at or above this amount requires admin approval before execution.
              </p>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ex-text-muted)]">$</span>
                  <input
                    type="number"
                    min="100"
                    step="100"
                    value={editedSettings.approval_threshold_usd || ""}
                    onChange={(e) =>
                      setEditedSettings((prev) => ({ ...prev, approval_threshold_usd: e.target.value }))
                    }
                    className="w-40 pl-7 pr-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <span className="text-sm text-[var(--ex-text-muted)]">USD threshold</span>
                {editedSettings.approval_threshold_usd !== swapSettings.approval_threshold_usd && (
                  <button
                    onClick={async () => {
                      setActionLoading("setting-approval_threshold_usd");
                      const res = await updateSwapPlatformSetting("approval_threshold_usd", editedSettings.approval_threshold_usd);
                      if (res.success) {
                        setSwapSettings((prev) => ({ ...prev, approval_threshold_usd: editedSettings.approval_threshold_usd }));
                        setMessage({ type: "success", text: "Approval threshold updated" });
                      } else {
                        setMessage({ type: "error", text: res.error });
                        setEditedSettings((prev) => ({ ...prev, approval_threshold_usd: swapSettings.approval_threshold_usd }));
                      }
                      setActionLoading(null);
                    }}
                    disabled={actionLoading === "setting-approval_threshold_usd"}
                    className="px-3 py-2 bg-sky-500 hover:bg-sky-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-medium rounded-md transition-colors"
                  >
                    {actionLoading === "setting-approval_threshold_usd" ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>

            {/* KYC Required Toggle */}
            <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
              <label className="block text-sm font-medium text-[var(--ex-text)] mb-1">
                KYC Requirement
              </label>
              <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
                When enabled, users must complete KYC verification (via the platform /GetKYC) before making fiat swaps.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    const newVal = editedSettings.kyc_required === "true" ? "false" : "true";
                    setActionLoading("setting-kyc_required");
                    const res = await updateSwapPlatformSetting("kyc_required", newVal);
                    if (res.success) {
                      setSwapSettings((prev) => ({ ...prev, kyc_required: newVal }));
                      setEditedSettings((prev) => ({ ...prev, kyc_required: newVal }));
                      setMessage({ type: "success", text: `KYC requirement ${newVal === "true" ? "enabled" : "disabled"}` });
                    } else {
                      setMessage({ type: "error", text: res.error });
                    }
                    setActionLoading(null);
                  }}
                  disabled={actionLoading === "setting-kyc_required"}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                    editedSettings.kyc_required === "true" ? "bg-emerald-500" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      editedSettings.kyc_required === "true" ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className={`text-sm font-medium ${
                  editedSettings.kyc_required === "true" ? "text-emerald-600" : "text-[var(--ex-text-muted)]"
                }`}>
                  {editedSettings.kyc_required === "true" ? "Required" : "Not Required"}
                </span>
                {actionLoading === "setting-kyc_required" && (
                  <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                )}
              </div>
            </div>

            {/* Trade KYC Required Toggle */}
            <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
              <label className="block text-sm font-medium text-[var(--ex-text)] mb-1">
                AMM Trade KYC Requirement
              </label>
              <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
                When enabled, users must complete KYC verification (via the platform /GetKYC) before trading on the AMM.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={async () => {
                    const newVal = editedSettings.kyc_required_trade === "true" ? "false" : "true";
                    setActionLoading("setting-kyc_required_trade");
                    const res = await updateSwapPlatformSetting("kyc_required_trade", newVal);
                    if (res.success) {
                      setSwapSettings((prev) => ({ ...prev, kyc_required_trade: newVal }));
                      setEditedSettings((prev) => ({ ...prev, kyc_required_trade: newVal }));
                      setMessage({ type: "success", text: `Trade KYC requirement ${newVal === "true" ? "enabled" : "disabled"}` });
                    } else {
                      setMessage({ type: "error", text: res.error });
                    }
                    setActionLoading(null);
                  }}
                  disabled={actionLoading === "setting-kyc_required_trade"}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                    editedSettings.kyc_required_trade === "true" ? "bg-emerald-500" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      editedSettings.kyc_required_trade === "true" ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className={`text-sm font-medium ${
                  editedSettings.kyc_required_trade === "true" ? "text-emerald-600" : "text-[var(--ex-text-muted)]"
                }`}>
                  {editedSettings.kyc_required_trade === "true" ? "Required" : "Not Required"}
                </span>
                {actionLoading === "setting-kyc_required_trade" && (
                  <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                )}
              </div>
            </div>

            {/* Processing Fee */}
            <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
              <label className="block text-sm font-medium text-[var(--ex-text)] mb-1">
                Fiat Swap Processing Fee
              </label>
              <p className="text-sm text-[var(--ex-text-subtle)] mb-3">
                Fee deducted from the output of each fiat-to-fiat swap. Set in basis points (100 bps = 1%). Default is 0 (disabled).
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="0"
                  max="1000"
                  step="1"
                  value={editedSettings.processing_fee_bps || "0"}
                  onChange={(e) =>
                    setEditedSettings((prev) => ({ ...prev, processing_fee_bps: e.target.value }))
                  }
                  className="w-32 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <span className="text-sm text-[var(--ex-text-muted)]">
                  bps ({((parseInt(editedSettings.processing_fee_bps) || 0) / 100).toFixed(2)}%)
                </span>
                {editedSettings.processing_fee_bps !== swapSettings.processing_fee_bps && (
                  <button
                    onClick={async () => {
                      setActionLoading("setting-processing_fee_bps");
                      const res = await updateSwapPlatformSetting("processing_fee_bps", editedSettings.processing_fee_bps);
                      if (res.success) {
                        setSwapSettings((prev) => ({ ...prev, processing_fee_bps: editedSettings.processing_fee_bps }));
                        setMessage({ type: "success", text: "Processing fee updated" });
                      } else {
                        setMessage({ type: "error", text: res.error });
                        setEditedSettings((prev) => ({ ...prev, processing_fee_bps: swapSettings.processing_fee_bps }));
                      }
                      setActionLoading(null);
                    }}
                    disabled={actionLoading === "setting-processing_fee_bps"}
                    className="px-3 py-2 bg-sky-500 hover:bg-sky-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-medium rounded-md transition-colors"
                  >
                    {actionLoading === "setting-processing_fee_bps" ? "Saving..." : "Save"}
                  </button>
                )}
              </div>
            </div>

            {/* Collected Fees Dashboard */}
            {feeStats && (
              <div className="p-4 bg-[var(--ex-surface-muted)] rounded-xl border border-[var(--ex-border)]">
                <label className="block text-sm font-medium text-[var(--ex-text)] mb-4">
                  Collected Fees (USDX)
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <div className="p-3 bg-[var(--ex-surface-muted)] rounded-lg border border-[var(--ex-border)]">
                    <p className="text-xs text-[var(--ex-text-subtle)] uppercase tracking-wider">Today</p>
                    <p className="text-lg font-bold text-[var(--ex-text)] mt-1">${formatMoney(feeStats.today)}</p>
                  </div>
                  <div className="p-3 bg-[var(--ex-surface-muted)] rounded-lg border border-[var(--ex-border)]">
                    <p className="text-xs text-[var(--ex-text-subtle)] uppercase tracking-wider">This Week</p>
                    <p className="text-lg font-bold text-[var(--ex-text)] mt-1">${formatMoney(feeStats.thisWeek)}</p>
                  </div>
                  <div className="p-3 bg-[var(--ex-surface-muted)] rounded-lg border border-[var(--ex-border)]">
                    <p className="text-xs text-[var(--ex-text-subtle)] uppercase tracking-wider">This Month</p>
                    <p className="text-lg font-bold text-[var(--ex-text)] mt-1">${formatMoney(feeStats.thisMonth)}</p>
                  </div>
                  <div className="p-3 bg-[var(--ex-surface-muted)] rounded-lg border border-emerald-500/20">
                    <p className="text-xs text-emerald-600 uppercase tracking-wider">All Time</p>
                    <p className="text-lg font-bold text-emerald-600 mt-1">${formatMoney(feeStats.allTime)}</p>
                  </div>
                </div>

                {feeStats.recentEntries.length > 0 && (
                  <div>
                    <p className="text-xs text-[var(--ex-text-subtle)] uppercase tracking-wider mb-2">Recent Fee Entries</p>
                    <div className="max-h-48 overflow-y-auto space-y-1.5">
                      {feeStats.recentEntries.map((entry, i) => (
                        <div key={i} className="flex items-center justify-between text-xs p-2 bg-[var(--ex-surface-muted)] rounded-lg">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded font-medium ${
                              entry.order_type === "buy" ? "text-emerald-600 bg-emerald-400/10" : "text-red-600 bg-red-400/10"
                            }`}>
                              {entry.order_type.toUpperCase()}
                            </span>
                            <span className="text-[var(--ex-text-muted)] font-mono">{entry.user_id.slice(0, 8)}...</span>
                          </div>
                          <div className="text-right">
                            <span className="text-amber-600 font-medium">${formatAmount(entry.fee_usdx, 6)}</span>
                            <span className="text-[var(--ex-text-subtle)] ml-2">({entry.fee_bps} bps)</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* API Keys Tab */}
      {activeTab === "apikeys" && (
        <div className="space-y-6">
          {/* Create Key Form */}
          <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm p-6">
            <h3 className="text-lg font-semibold text-[var(--ex-text)] mb-4">Create Checkout API Key</h3>
            <form onSubmit={handleCreateApiKey} className="flex gap-3">
              <input
                type="text"
                placeholder="Key name (e.g. PLAT .NET Production)"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="flex-1 px-3 py-2 bg-white border border-[var(--ex-border)] rounded-lg text-[var(--ex-text)] placeholder-[var(--ex-text-subtle)] focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <button
                type="submit"
                disabled={!newKeyName.trim() || actionLoading === "create-key"}
                className="px-4 py-2 bg-sky-500 hover:bg-sky-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors"
              >
                {actionLoading === "create-key" ? "Creating..." : "Generate Key"}
              </button>
            </form>

            {createdKey && (
              <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-3">
                <p className="text-sm font-medium text-emerald-600">
                  Key created successfully. Copy these values now — the secret will not be shown again.
                </p>
                <div>
                  <label className="text-xs text-[var(--ex-text-muted)] uppercase tracking-wider">API Key (X-API-Key header)</label>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-[var(--ex-surface-muted)] rounded-lg text-emerald-600 font-mono text-sm break-all">
                      {createdKey.keyId}
                    </code>
                    <button
                      onClick={() => navigator.clipboard.writeText(createdKey.keyId)}
                      className="px-3 py-2 cursor-pointer bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] rounded-md transition-colors text-sm flex-shrink-0"
                    >
                      Copy
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--ex-text-muted)] uppercase tracking-wider">API Secret (X-API-Secret header)</label>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-[var(--ex-surface-muted)] rounded-lg text-amber-600 font-mono text-sm break-all">
                      {createdKey.secret}
                    </code>
                    <button
                      onClick={() => navigator.clipboard.writeText(createdKey.secret)}
                      className="px-3 py-2 cursor-pointer bg-[var(--ex-surface-muted)] hover:bg-slate-200 border-2 border-sky-500 text-[var(--ex-text)] rounded-md transition-colors text-sm flex-shrink-0"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Keys List */}
          <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm overflow-hidden">
            <div className="p-6 border-b border-[var(--ex-border)]">
              <h2 className="text-lg font-semibold text-[var(--ex-text)] flex items-center gap-2">
                <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                Checkout API Keys
              </h2>
            </div>

            {apiKeys.length === 0 ? (
              <div className="p-8 text-center text-[var(--ex-text-muted)]">
                No API keys created yet
              </div>
            ) : (
              <div className="divide-y divide-[var(--ex-border)]">
                {apiKeys.map((key) => (
                  <div key={key.key_id} className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[var(--ex-text)] font-medium">{key.name}</span>
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                          key.is_active
                            ? "text-emerald-600 bg-emerald-400/10"
                            : "text-red-600 bg-red-400/10"
                        }`}>
                          {key.is_active ? "Active" : "Revoked"}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--ex-text-muted)] font-mono truncate">{key.key_id}</p>
                      <div className="text-xs text-[var(--ex-text-subtle)] mt-1 flex gap-4">
                        <span>Created: {formatDate(key.created_at)}</span>
                        <span>Permissions: {key.permissions.join(", ")}</span>
                        {key.revoked_at && <span className="text-red-600">Revoked: {formatDate(key.revoked_at)}</span>}
                      </div>
                    </div>

                    {key.is_active && (
                      <button
                        onClick={() => handleRevokeApiKey(key.key_id)}
                        disabled={actionLoading === key.key_id}
                        className="px-4 py-2 bg-red-600 hover:bg-red-700 cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium rounded-md transition-colors text-sm flex-shrink-0"
                      >
                        {actionLoading === key.key_id ? "Revoking..." : "Revoke"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function AdminContentSkeleton() {
  return (
    <div className="bg-[var(--ex-surface)] rounded-2xl border border-[var(--ex-border)] shadow-sm p-6 space-y-5">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-56" />
        <SkeletonBlock className="h-4 w-full max-w-lg" />
      </div>
      <div className="divide-y divide-[var(--ex-border)]">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 py-4">
            <div className="flex-1 space-y-2">
              <SkeletonBlock className="h-4 w-1/3" />
              <SkeletonBlock className="h-3 w-1/4" />
            </div>
            <SkeletonBlock className="h-8 w-24 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

