// app/actions/dashboard.ts
"use server";

// Server actions powering the new "Wallet Overview" dashboard.
//
// We intentionally aggregate data here (instead of calling 4-5 actions
// from the client) so the dashboard does ONE network round-trip. Each
// downstream call is wrapped in try/catch so a partial outage (e.g. the
// AMM RPC is down) still renders the rest of the dashboard.

import { getServerSession } from "@/app/lib/auth-service";
import {
  getAllUserBalances,
  getSwapHistory,
  type UserBalance,
} from "@/app/lib/ledger-service";
import { getAllRates } from "@/app/lib/chainlink-service";
import { getOrderHistory } from "@/app/lib/trade-order-service";
import {
  getUserCashouts,
  expireInFlightOrders,
  resolveCashoutDisplayFiat,
} from "@/app/lib/cashout-service";
import {
  getPoolInfo,
  getPlatSpotPriceHistory,
} from "@/app/lib/amm-service";
import {
  getOrderHistory as getStakingOrderHistory,
  type StakingOrder,
} from "@/app/lib/staking-order-service";
import { getOffRampCryptoConfig } from "@/app/lib/transak-service";
import type { FiatCurrency } from "@/app/lib/payment-service";
import { db } from "@/app/lib/db";

/**
 * Chain the off-ramp treasury transfer lands on. `TRANSAK_ENVIRONMENT
 * == "PRODUCTION"` uses real USDC on Base mainnet; staging uses the
 * test ERC-20 on Base Sepolia. AMM / trade / staking activity is
 * always on Base mainnet regardless of this flag.
 */
const OFF_RAMP_CHAIN: "base" | "base-sepolia" = getOffRampCryptoConfig()
  .isProduction
  ? "base"
  : "base-sepolia";
import type { FieldPacket, RowDataPacket } from "mysql2";

/**
 * Staking rewards below this threshold (in PLAT) round to "0.00" at
 * the activity feed's 2-decimal display precision, so rendering them as
 * a separate "Collect Rewards" row would show "+ 0.00 PLAT" and
 * look broken. We silently drop the row instead. Mirrors the constant
 * of the same name in `components/Staking.tsx`.
 */
const DUST_REWARD_THRESHOLD = 0.01;

export type DashboardActivityKind =
  | "buy"
  | "sell"
  | "swap"
  | "cashout"
  | "refund"
  | "stake"
  | "unstake"
  | "reward";

export interface DashboardActivity {
  id: string;
  kind: DashboardActivityKind;
  /** Human-readable headline (e.g. "Buy PLAT", "Swap EURX → USDX") */
  title: string;
  /**
   * Outflow side, formatted as "- <amount> <unit>" (e.g. "- 100.00 USD").
   * `null` for one-sided inflow rows (Withdraw Deposit, Collect
   * Rewards, Emergency Withdrawal) — the renderer shows "—" in the
   * Paid column instead.
   */
  paidLabel: string | null;
  /**
   * Inflow side, formatted as "+ <amount> <unit>" (e.g. "+ 25.39
   * PLAT"). `null` for one-sided outflow rows (Deposit for Rewards /
   * stake) — the renderer shows "—" in the Received column instead.
   */
  receivedLabel: string | null;
  /**
   * Positive / negative / neutral — drives the color of the Received
   * column. The Paid column always renders muted grey because outflow
   * is purely directional, never a "loss" worth coloring.
   */
  amountTone: "positive" | "negative" | "neutral";
  /** ISO timestamp. The client formats it. */
  createdAt: string;
  /**
   * UI status pill. `cancelled` is intentionally separate from `failed`
   * so the activity feed can tell the user apart "you stopped this
   * yourself / it was auto-refunded" (neutral) from "the chain or
   * Transak actually errored" (alarming).
   */
  status: "success" | "pending" | "failed" | "cancelled";
  /**
   * On-chain transaction hash, when the row has one. Trade orders +
   * staking orders use the operator wallet's tx hash; off-ramp cashouts
   * use the treasury → Transak transfer hash. Internal ledger swaps
   * don't touch chain state and stay `null`.
   *
   * Paired with `txChain` so the client picks the right block explorer:
   * AMM / trade / staking activity always lives on Base mainnet, but the
   * off-ramp treasury transfer uses Base Sepolia in `TRANSAK_ENVIRONMENT
   * != "PRODUCTION"` (Transak's test ERC-20 lives on Sepolia). Linking
   * a Sepolia hash at `basescan.org/tx/...` produces a "not found" page,
   * which is exactly the bug this field exists to prevent.
   */
  txHash: string | null;
  /**
   * Block-explorer chain identifier for `txHash`. `null` when `txHash`
   * is `null`. Currently one of:
   *   • `"base"`         → `https://basescan.org/tx/<hash>`
   *   • `"base-sepolia"` → `https://sepolia.basescan.org/tx/<hash>`
   */
  txChain: "base" | "base-sepolia" | null;
  /**
   * Human-friendly explanation of WHY a `failed` row failed. Only set
   * when status === "failed" AND the backend gave us context — null
   * otherwise. Cancellations (user-initiated, auto-refund, abandoned)
   * are intentionally not annotated: the "Cancelled" pill already
   * conveys that nothing went wrong, so a subtitle would be noise.
   */
  failureReason?: string | null;
}

export interface DashboardSnapshot {
  balances: UserBalance[];
  /** USD rate per T Fiat token (USDX = 1, others from Chainlink/Pyth). */
  rates: Record<string, number>;
  /** Combined balance across all tokens, denominated in USD. */
  totalUsd: number;
  /** Most recent activity, capped at 8 rows for the table. */
  activity: DashboardActivity[];
  /** PLAT spot price in USDX (≈ USD), if the AMM is reachable. */
  platPriceUsd: number | null;
}

const ACTIVITY_LIMIT = 8;
/**
 * Max rows returned by `getFullActivityAction` — what the Dashboard's
 * "Transaction history" modal pages through with its scroll. Larger
 * than `ACTIVITY_LIMIT` so the modal isn't a duplicate of the main
 * 8-row table.
 */
const FULL_ACTIVITY_LIMIT = 50;

export async function getDashboardSnapshot(
  activityFilter: ActivityFilter = "all"
): Promise<
  | { success: true; data: DashboardSnapshot }
  | { success: false; error: string }
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  // Fire-and-forget global stale-order sweep. This is the same sweep
  // the Exchange page kicks off on mount, but moving it here means
  // ANY page load that pulls the dashboard snapshot (so: Dashboard,
  // Exchange) refunds stale awaiting_transak cashouts — including
  // those belonging to users who never come back. Without this the
  // refund only landed when someone happened to open Exchange, which
  // could be hours or days for a user who abandoned a Transak window.
  //
  // The sweep is O(N) in stale rows (typically 0), and the common-
  // case is three indexed UPDATEs that return immediately. Not
  // awaited so it never blocks the snapshot response.
  expireInFlightOrders().catch((err) => {
    console.error("[dashboard] expire sweep failed:", err);
  });

  // Fan out — each call is independently wrapped so one failure cannot
  // break the whole dashboard. `activityFilter` lets per-surface pages
  // ask for an already-scoped activity list (exchange/staking) so they
  // don't need a second round-trip — important for keeping the MySQL
  // pool from saturating on page load.
  const [balances, ratesResult, platPriceUsd, activity] = await Promise.all([
    safe(() => getAllUserBalances(session.userId), [] as UserBalance[]),
    safe(async () => {
      const data = await getAllRates();
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(data)) out[k] = v.rate;
      return out;
    }, {} as Record<string, number>),
    safe(async () => {
      const pool = await getPoolInfo();
      const n = parseFloat(pool.spotPrice);
      return Number.isFinite(n) ? n : null;
    }, null as number | null),
    loadActivity(session.userId, ACTIVITY_LIMIT, activityFilter),
  ]);

  // USDX is always 1:1 USD; PLAT price is denominated in USDX per
  // token, so it doubles as USD per token for the totals math.
  const rates: Record<string, number> = {
    USDX: 1,
    ...ratesResult,
  };
  if (platPriceUsd != null) rates.PLAT = platPriceUsd;

  let totalUsd = 0;
  for (const b of balances) {
    const rate = rates[b.token_symbol];
    if (rate == null) continue;
    const amount = parseFloat(b.balance);
    if (Number.isFinite(amount)) totalUsd += amount * rate;
  }

  return {
    success: true,
    data: { balances, rates, totalUsd, activity, platPriceUsd },
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error("[dashboard] subquery failed:", err);
    return fallback;
  }
}

/**
 * Pull the last few items across trades, cashouts, swaps, and staking
 * and merge them into a unified activity feed. Sorted desc by createdAt.
 *
 * Staking covers all four order types — `stake`, `unstake`, `claim`,
 * `emergency_withdraw` — so deposits, withdrawals, and reward claims
 * all appear in the dashboard feed alongside Exchange activity.
 *
 * `limit` controls both the per-source fetch and the final slice. The
 * Dashboard hero feed passes `ACTIVITY_LIMIT` (8); the "See all" modal
 * passes `FULL_ACTIVITY_LIMIT` (50) for a longer scrollable list.
 */
/**
 * Source-group filter for the activity feed. The dashboard mixes
 * everything; the per-page modals filter to just their own surface so
 * the Exchange "See all" doesn't leak staking rows (and vice-versa).
 */
export type ActivityFilter = "all" | "exchange" | "staking";

/**
 * Joined onramp_orders + swap_transactions row used by the stable top-up
 * activity loop. The swap-side columns are NULL for USDX targets (no swap
 * needed) and for non-USD targets where the post-credit ledger swap hasn't
 * landed yet (the in-flight window before the webhook chain completes).
 */
interface OnRampActivityRow extends RowDataPacket {
  partner_order_id: string | null;
  fiat_currency: string;
  fiat_amount: string;
  tusd_amount: string;
  target_token: string;
  target_swap_transaction_id: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
  swap_to_amount: string | null;
  swap_to_token: string | null;
}

async function loadActivity(
  userId: string,
  limit: number,
  filter: ActivityFilter = "all",
  offset: number = 0
): Promise<DashboardActivity[]> {
  // For paginated calls (offset > 0) we need to fetch enough rows from
  // each source to cover positions [offset, offset+limit) after the
  // cross-source merge. Source-level offset wouldn't translate
  // correctly because the merged feed interleaves by createdAt — the
  // Nth item of the merged feed isn't the Nth item of any one source.
  // So we always fetch (offset + limit) from each source, merge + sort
  // the lot, then slice the requested window from the merged array.
  //
  // Trade-off: re-fetches the same prefix on each "Load more" click.
  // Cheap at modest scale (hundreds of rows); if histories ever get
  // large enough to matter, swap this for cursor-based pagination
  // (WHERE created_at < lastSeenCursor LIMIT N per source).
  const fetchSize = offset + limit;
  // Skip the un-needed source fetches entirely when filtering. A "staking"
  // call shouldn't even talk to trade-orders / cashouts / swaps.
  const wantExchange = filter === "all" || filter === "exchange";
  const wantStaking = filter === "all" || filter === "staking";
  const [trades, cashouts, swaps, stakingOrders, onramps] = await Promise.all([
    wantExchange
      ? safe(() => getOrderHistory(userId, fetchSize, 0), [])
      : Promise.resolve([] as Awaited<ReturnType<typeof getOrderHistory>>),
    wantExchange
      ? safe(() => getUserCashouts(userId, fetchSize, 0), [])
      : Promise.resolve([] as Awaited<ReturnType<typeof getUserCashouts>>),
    wantExchange
      ? safe(
          () => getSwapHistory(userId, fetchSize, 0) as Promise<SwapHistoryRow[]>,
          [] as SwapHistoryRow[]
        )
      : Promise.resolve([] as SwapHistoryRow[]),
    wantStaking
      ? safe(
          () => getStakingOrderHistory(userId, fetchSize, 0),
          [] as StakingOrder[]
        )
      : Promise.resolve([] as StakingOrder[]),
    wantExchange
      ? safe(async () => {
          // Stable top-ups (standalone on-ramp orders with a target_token).
          // JOINed against swap_transactions so non-USD targets show the
          // actual amount received post-conversion rather than the USDX
          // intermediate. The JOIN is LEFT so USDX targets (and any rows
          // where the swap leg hasn't settled yet) still come back.
          const [rows] = await db.query<OnRampActivityRow[]>(
            `SELECT
              o.partner_order_id, o.fiat_currency, o.fiat_amount,
              o.tusd_amount, o.target_token, o.target_swap_transaction_id,
              o.status, o.failure_reason, o.created_at,
              s.to_amount  AS swap_to_amount,
              s.to_token   AS swap_to_token
             FROM onramp_orders o
             LEFT JOIN swap_transactions s
               ON s.transaction_id = o.target_swap_transaction_id
             WHERE o.user_id = ? AND o.target_token IS NOT NULL
             ORDER BY o.created_at DESC
             LIMIT ?`,
            [userId, fetchSize]
          );
          return rows;
        }, [] as OnRampActivityRow[])
      : Promise.resolve([] as OnRampActivityRow[]),
  ]);

  const items: DashboardActivity[] = [];

  // Pre-resolve cashout "received" amounts — legacy rows stored gross
  // tusd in fiat_amount; ask Transak fee quote for accurate net display.
  const cashoutReceived = await Promise.all(
    cashouts.map((c) =>
      resolveCashoutDisplayFiat(
        c.fiat_amount,
        c.tusd_amount,
        c.fiat_currency as FiatCurrency
      )
    )
  );

  for (const t of trades) {
    // Convert orders (order_type='convert') get a distinct row shape:
    // both sides are tokens, no fiat involved, title reads "Convert
    // FROM → TO" so users recognise it as a Convert tab action rather
    // than a Buy/Sell. The activity badge stays the swap icon (kind:
    // "swap") for the same reason.
    if (t.order_type === "convert") {
      const fromAmt = parseFloat(t.from_amount || "0");
      const toAmt = parseFloat(t.to_amount || "0");
      const fromTok = t.from_token ?? "?";
      const toTok = t.to_token ?? "?";
      const convertStatus = mapTradeStatus(t.status);
      items.push({
        id: `trade:${t.order_id}`,
        kind: "swap",
        title: `Convert ${fromTok} → ${toTok}`,
        paidLabel: `- ${formatAmt(fromAmt)} ${fromTok}`,
        receivedLabel: toAmt > 0 ? `+ ${formatAmt(toAmt)} ${toTok}` : null,
        amountTone: "positive",
        createdAt: t.created_at,
        status: convertStatus,
        txHash: t.operator_tx_hash ?? null,
        txChain: t.operator_tx_hash ? "base" : null,
        failureReason: deriveTradeFailureReason(
          t.status,
          t.failure_reason ?? null
        ),
      });
      continue;
    }

    const isBuy = t.order_type === "buy";
    const tglobalAmount = parseFloat(t.tglobal_amount || "0");
    const fiatAmount = parseFloat(t.fiat_amount || "0");
    const payoutAmount = parseFloat(t.payout_amount || "0");
    const payoutCurrency = t.payout_currency ?? t.fiat_currency;
    const status = mapTradeStatus(t.status);
    items.push({
      id: `trade:${t.order_id}`,
      kind: isBuy ? "buy" : "sell",
      title: isBuy ? "Buy PLAT" : "Sell PLAT",
      // Buy: fiat out → PLAT in. Sell: PLAT out → fiat in.
      // `formatActivityAmount` on the client prepends the right fiat
      // symbol ($, €, £, R$) to bare fiat codes.
      paidLabel: isBuy
        ? `- ${formatAmt(fiatAmount)} ${t.fiat_currency}`
        : `- ${formatAmt(tglobalAmount)} PLAT`,
      receivedLabel: isBuy
        ? `+ ${formatAmt(tglobalAmount)} PLAT`
        : `+ ${formatAmt(payoutAmount)} ${payoutCurrency}`,
      amountTone: "positive",
      createdAt: t.created_at,
      status,
      txHash: t.operator_tx_hash ?? null,
      txChain: t.operator_tx_hash ? "base" : null,
      failureReason: deriveTradeFailureReason(t.status, t.failure_reason ?? null),
    });
  }

  for (let ci = 0; ci < cashouts.length; ci++) {
    const c = cashouts[ci];
    const tokenAmount = parseFloat(c.token_amount || "0");
    const fiatAmount = cashoutReceived[ci];
    const tusdAmount = parseFloat(c.tusd_amount || "0");
    const status = mapCashoutStatus(c.status, c.failure_reason ?? null);
    items.push({
      id: `cashout:${c.cashout_id}`,
      kind: "cashout",
      title: `Sell ${c.token}`,
      // Token sold → fiat received. For cancelled cashouts the fiat was
      // never actually paid out — clear the received side so the row
      // doesn't read as "you got X USD" when in fact the user got their
      // tokens refunded (surfaced as a separate refund row below).
      paidLabel: `- ${formatAmt(tokenAmount)} ${c.token}`,
      receivedLabel:
        status === "cancelled"
          ? null
          : `+ ${formatAmt(fiatAmount)} ${c.fiat_currency}`,
      amountTone: "positive",
      createdAt: c.created_at,
      status,
      // Off-ramp publishes two hashes: treasury_tx_hash (crypto sent
      // from treasury → Transak) is the user-meaningful one; fall back
      // to operator_tx_hash if the cashout was settled internally.
      // The two hashes live on different chains in staging: the
      // treasury transfer runs on Base Sepolia (test ERC-20), while
      // the operator's AMM swap (PLAT → USDX on cancellation) is
      // always Base mainnet. Tag the row with the chain that matches
      // whichever hash we ended up using.
      txHash: c.treasury_tx_hash ?? c.operator_tx_hash ?? null,
      txChain: c.treasury_tx_hash
        ? OFF_RAMP_CHAIN
        : c.operator_tx_hash
        ? "base"
        : null,
      failureReason:
        status === "failed" ? deriveCashoutFailureReason(c.failure_reason ?? null) : null,
    });

    // Emit a separate "Refund Received" row for cancelled cashouts so
    // the user has a positive-tone confirmation that their funds came
    // back. The cashout row above only shows the outflow + "Cancelled"
    // pill, which can read as a loss at a glance — without this entry,
    // users have to infer the refund from their balance going back up.
    //
    // Mirrors the refund rules in cashout-service:
    //   • PLAT with AMM swap already executed → refunded as USDX
    //     (because that's what the treasury actually holds). Render as
    //     a dual-column "swap-like" row to make the unit change clear.
    //   • Stable cashouts → refunded in the same token, same amount.
    //     Render as a single-sided inflow row.
    if (status === "cancelled") {
      const refundedAsUsdx =
        c.token === "PLAT" && !!c.operator_tx_hash && tusdAmount > 0;
      const refundAmount = refundedAsUsdx ? tusdAmount : tokenAmount;
      const refundToken = refundedAsUsdx ? "USDX" : c.token;
      if (refundAmount > 0) {
        items.push({
          id: `refund:${c.cashout_id}`,
          kind: "refund",
          title: `Refund Received (in ${refundToken})`,
          paidLabel: refundedAsUsdx
            ? `- ${formatAmt(tokenAmount)} ${c.token}`
            : null,
          receivedLabel: `+ ${formatAmt(refundAmount)} ${refundToken}`,
          amountTone: "positive",
          // Use the cashout's processed_at if available so the refund
          // row sorts at the moment the refund actually landed (often
          // hours after the failed sell). Falls back to created_at so
          // historical rows without a processed_at still surface.
          createdAt: c.processed_at ?? c.created_at,
          status: "success",
          // No on-chain hash for ledger refunds — the credit is an
          // off-chain adjustment, not a transfer.
          txHash: null,
          txChain: null,
        });
      }
    }
  }

  // Build the set of swap transaction ids that are chained legs of
  // larger user-facing operations and should NOT appear as their own
  // "Swap A → B" rows in the activity feed:
  //   • Non-USD stable top-ups: the USDX → target ledger leg is linked
  //     to an onramp_order via `target_swap_transaction_id`. The on-ramp
  //     loop below renders the full "Buy PLAT{X}" row with the final
  //     amount, so the swap row would be a duplicate.
  //   • Convert involving PLAT on a non-USD pair: the USDX ↔ stable
  //     ledger leg is linked to a trade_orders convert row via
  //     `payout_swap_transaction_id`. The trade loop above already
  //     rendered the "Convert FROM → TO" row, so the swap row would be
  //     a duplicate.
  const onrampLinkedSwapIds = new Set<string>(
    onramps
      .map((o) => o.target_swap_transaction_id)
      .filter((id): id is string => !!id)
  );
  const convertLinkedSwapIds = new Set<string>(
    trades
      .filter((t) => t.order_type === "convert")
      .map((t) => t.payout_swap_transaction_id)
      .filter((id): id is string => !!id)
  );

  for (const s of swaps) {
    if (s.transaction_id && onrampLinkedSwapIds.has(s.transaction_id)) {
      continue;
    }
    if (s.transaction_id && convertLinkedSwapIds.has(s.transaction_id)) {
      continue;
    }
    const fromAmount = parseFloat(s.from_amount || "0");
    const toAmount = parseFloat(s.to_amount || "0");
    items.push({
      id: `swap:${s.transaction_id ?? s.id}`,
      kind: "swap",
      title: `Swap ${s.from_token} → ${s.to_token}`,
      // Source token spent → destination token gained.
      paidLabel: `- ${formatAmt(fromAmount)} ${s.from_token}`,
      receivedLabel: `+ ${formatAmt(toAmount)} ${s.to_token}`,
      amountTone: "positive",
      createdAt: s.created_at,
      status: "success",
      // Internal ledger swaps don't touch the chain — no hash.
      txHash: null,
      txChain: null,
    });
  }

  for (const o of onramps) {
    // Stable top-up (card → stablecoin via standalone on-ramp). The trade
    // loop above handles the PLAT path (which lives in trade_orders);
    // these rows only exist when the user picked one of the four stables
    // in the Buy form.
    const targetToken = o.target_token;
    const fiatAmount = parseFloat(o.fiat_amount || "0");
    const tusdAmount = parseFloat(o.tusd_amount || "0");
    const status = mapOnRampStatus(o.status, o.failure_reason ?? null);

    // Receive side: branch on whether the order has settled AND whether the
    // optional post-credit ledger swap to a non-USD stable has landed yet.
    // For unsettled rows we omit the receive label entirely; the "Pending"
    // pill in the status column already tells the user the credit hasn't
    // arrived. For non-USD targets where the swap row exists, prefer the
    // actual `to_amount` from swap_transactions over a rate-snapshot
    // estimate. For non-USD targets where the swap row is missing despite
    // a completed credit (swap failed and the USDX is still in the
    // ledger), fall back to USDX so the row reflects reality.
    let receivedAmount: number | null = null;
    let receivedToken: string | null = null;
    if (o.status === "completed") {
      if (targetToken === "USDX") {
        receivedAmount = tusdAmount;
        receivedToken = "USDX";
      } else if (o.swap_to_amount && o.swap_to_token) {
        receivedAmount = parseFloat(o.swap_to_amount);
        receivedToken = o.swap_to_token;
      } else {
        receivedAmount = tusdAmount;
        receivedToken = "USDX";
      }
    }

    items.push({
      // Onramps don't have a stable trade_order_id; partner_order_id is the
      // user-scoped unique handle (also what the Buy form polls against).
      id: `onramp:${o.partner_order_id ?? o.created_at}`,
      kind: "buy",
      title: `Buy ${targetToken}`,
      paidLabel: `- ${formatAmt(fiatAmount)} ${o.fiat_currency}`,
      receivedLabel:
        receivedAmount != null && receivedToken
          ? `+ ${formatAmt(receivedAmount)} ${receivedToken}`
          : null,
      amountTone: "positive",
      createdAt: o.created_at,
      status,
      // Standalone on-ramp doesn't expose an operator tx hash to the user
      // (the Transak → treasury transfer is the only on-chain action and
      // it's batched / not user-meaningful). Internal swap leg also has no
      // on-chain footprint. Leaving null suppresses the "More Details"
      // BaseScan deep-link, which is the correct behaviour.
      txHash: null,
      txChain: null,
      failureReason:
        status === "failed" ? o.failure_reason ?? null : null,
    });
  }

  for (const o of stakingOrders) {
    const principal = parseFloat(o.amount || "0");
    const reward = parseFloat(o.reward_amount || "0");
    const txHash = o.operator_tx_hash ?? null;
    // Staking contract lives on Base mainnet regardless of the off-ramp
    // staging flag, so the chain is always "base" when we have a hash.
    const txChain: "base" | null = txHash ? "base" : null;
    switch (o.order_type) {
      case "stake":
        items.push({
          id: `staking:${o.order_id}`,
          kind: "stake",
          title: "Deposited for Rewards",
          // Tokens LEAVING the wallet into the staking contract —
          // paid-only row. Received column shows "—".
          paidLabel: `- ${formatAmt(principal)} PLAT`,
          receivedLabel: null,
          amountTone: "neutral",
          createdAt: o.created_at,
          status: mapStakingStatus(o.status),
          txHash,
          txChain,
        });
        break;
      case "unstake":
        // The on-chain `unstakeFor` always releases the principal AND
        // any accrued rewards in a single tx. We split this into two
        // activity rows so the user sees clean numbers + the rewards
        // get their own "Collect Rewards" icon, instead of a clunky
        // "+ X PLAT (+Y rewards)" composite label.
        items.push({
          id: `staking:${o.order_id}`,
          kind: "unstake",
          title: "Withdraw Deposit",
          // Principal returning to wallet — received-only.
          paidLabel: null,
          receivedLabel: `+ ${formatAmt(principal)} PLAT`,
          amountTone: "positive",
          createdAt: o.created_at,
          status: mapStakingStatus(o.status),
          txHash,
          txChain,
        });
        if (reward >= DUST_REWARD_THRESHOLD) {
          items.push({
            // `:reward` suffix keeps the React key unique alongside the
            // principal row that shares this order_id.
            id: `staking:${o.order_id}:reward`,
            kind: "reward",
            title: "Collect Rewards",
            paidLabel: null,
            receivedLabel: `+ ${formatAmt(reward)} PLAT`,
            amountTone: "positive",
            createdAt: o.created_at,
            status: mapStakingStatus(o.status),
            // Same on-chain tx as the principal — BaseScan link goes
            // to the same place.
            txHash,
            txChain,
          });
        }
        break;
      case "claim":
        items.push({
          id: `staking:${o.order_id}`,
          kind: "reward",
          title: "Collect Rewards",
          // For claim orders the `amount` column is zero and the
          // meaningful number lives in `reward_amount`.
          paidLabel: null,
          receivedLabel: `+ ${formatAmt(reward > 0 ? reward : principal)} PLAT`,
          amountTone: "positive",
          createdAt: o.created_at,
          status: mapStakingStatus(o.status),
          txHash,
          txChain,
        });
        break;
      case "emergency_withdraw":
        // Same direction as unstake (tokens leaving the stake), so use
        // the up-arrow `unstake` kind.
        items.push({
          id: `staking:${o.order_id}`,
          kind: "unstake",
          title: "Emergency Withdrawal",
          paidLabel: null,
          receivedLabel: `+ ${formatAmt(principal)} PLAT`,
          amountTone: "neutral",
          createdAt: o.created_at,
          status: mapStakingStatus(o.status),
          txHash,
          txChain,
        });
        break;
    }
  }

  items.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Window the merged + sorted feed to the requested page. With
  // offset=0 this is just the first `limit` rows (the original
  // behavior); with offset>0 it returns the next page.
  return items.slice(offset, offset + limit);
}

/**
 * PLAT spot-price history for the Dashboard chart. Indexes the AMM's
 * on-chain `Swap` events and buckets into either 7 daily samples ("day"
 * granularity, the default) or 24 hourly samples ("hour" granularity,
 * used by the Dashboard's "1H" toggle). Fetched separately from
 * `getDashboardSnapshot` so a slow `getLogs` scan never blocks the
 * snapshot.
 */
export async function getPlatPriceHistoryAction(
  granularity: "day" | "hour" = "day"
): Promise<
  | { success: true; data: number[] }
  | { success: false; error: string }
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };
  try {
    const series = await getPlatSpotPriceHistory(granularity);
    if (series == null) {
      return { success: false, error: "Price history unavailable" };
    }
    return { success: true, data: series };
  } catch (err) {
    console.error("[dashboard] getPlatPriceHistoryAction failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load price history",
    };
  }
}

/**
 * Fetch the full unified activity feed (up to `FULL_ACTIVITY_LIMIT`
 * rows) for the "See all" Transaction history modal. Same merge +
 * sort logic as the dashboard snapshot — just a larger window and an
 * optional `filter` so per-page modals don't show cross-surface rows.
 */
export async function getFullActivityAction(
  filter: ActivityFilter = "all",
  limit: number = FULL_ACTIVITY_LIMIT,
  offset: number = 0
): Promise<
  | { success: true; data: DashboardActivity[] }
  | { success: false; error: string }
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };
  try {
    const data = await loadActivity(session.userId, limit, filter, offset);
    return { success: true, data };
  } catch (err) {
    console.error("[dashboard] getFullActivityAction failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load activity",
    };
  }
}

interface SwapHistoryRow {
  id?: number | string;
  transaction_id?: string;
  from_token: string;
  to_token: string;
  from_amount: string;
  to_amount: string;
  created_at: string;
}

function mapTradeStatus(
  s: string
): "success" | "pending" | "failed" | "cancelled" {
  if (s === "completed") return "success";
  // The DB has an explicit `cancelled` row for user-initiated trade
  // cancellations — surface it as its own UI pill.
  if (s === "cancelled") return "cancelled";
  // Genuine failure cases: chain reverted, price moved past slippage,
  // operator wallet drained, etc.
  if (s === "failed" || s === "insufficient_balance" || s === "price_changed") {
    return "failed";
  }
  return "pending";
}

function mapCashoutStatus(
  s: string,
  failureReason: string | null
): "success" | "pending" | "failed" | "cancelled" {
  if (s === "completed") return "success";
  if (s === "failed") {
    // Cashouts use `status = 'failed'` for both genuine errors AND
    // cancellations — distinguish by the failure_reason marker the
    // three cancellation paths in cashout-service.ts write:
    //   • "Cancelled by user before Transak crypto deposit" (user cancel)
    //   • "Abandoned: <notes>"                              (admin abandon)
    //   • "Auto-refund: …"                                  (system reconcile)
    const reason = failureReason ?? "";
    const isCancellation =
      reason.startsWith("Cancelled by user") ||
      reason.startsWith("Abandoned:") ||
      reason.startsWith("Auto-refund:");
    return isCancellation ? "cancelled" : "failed";
  }
  return "pending";
}

function mapStakingStatus(
  s: string
): "success" | "pending" | "failed" | "cancelled" {
  if (s === "completed") return "success";
  if (s === "failed") return "failed";
  // "pending" + "executing" both surface as pending in the UI.
  // Staking has no cancellation flow, so "cancelled" is never emitted.
  return "pending";
}

function mapOnRampStatus(
  s: string,
  failureReason: string | null
): "success" | "pending" | "failed" | "cancelled" {
  if (s === "completed") return "success";
  if (s === "failed") {
    // On-ramp_orders has no literal 'cancelled' enum value, so we use
    // 'failed' for both genuine errors AND cancellations and distinguish
    // by the failure_reason prefix the cancellation paths write:
    //   • "Cancelled by admin …"        (bell-icon bulk cancel)
    //   • "Cancelled by user …"         (future: user-initiated cancel)
    //   • "Auto-cancelled: …"           (2h hard-timeout reconciler)
    // Same convention as mapCashoutStatus.
    const reason = failureReason ?? "";
    const isCancellation =
      reason.startsWith("Cancelled by admin") ||
      reason.startsWith("Cancelled by user") ||
      reason.startsWith("Auto-cancelled:");
    return isCancellation ? "cancelled" : "failed";
  }
  // Treat 'refunded' as cancelled (neutral) rather than failed (alarming):
  // a Transak refund means the card was never charged, so there's nothing
  // to alert the user about beyond "this didn't go through."
  if (s === "refunded") return "cancelled";
  // 'pending' (user hasn't paid yet) + 'processing' (Transak has the
  // payment, working on settlement) both surface as pending.
  return "pending";
}

/**
 * Map a trade order's raw status + backend failure_reason into the
 * short, user-friendly subtitle that renders under the "Failed" pill.
 * Returns null for non-failure rows so the renderer can skip the
 * subtitle entirely (avoids reserving vertical space on healthy rows).
 *
 * The DB folds multiple failure paths into the same UI "failed" pill
 * via `mapTradeStatus`, so we recover the specific reason here:
 *   • "insufficient_balance" — the most common known cause, mapped to
 *     a short canonical string
 *   • "price_changed"        — AMM slippage tripped during execution
 *   • "failed"               — generic; fall back to the operator's
 *     free-text `failure_reason` if present, otherwise a safe default
 */
function deriveTradeFailureReason(
  rawStatus: string,
  rawReason: string | null
): string | null {
  if (rawStatus === "insufficient_balance") return "Insufficient balance";
  if (rawStatus === "price_changed") return "Price moved beyond limit";
  if (rawStatus === "failed") {
    const trimmed = rawReason?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : "Transaction failed";
  }
  return null;
}

/**
 * Cashouts collapse cancellations into `status = 'failed'` (with a
 * marker prefix in failure_reason that `mapCashoutStatus` uses to
 * route to the "Cancelled" pill). By the time this helper runs we've
 * already confirmed it's a real failure — just clean up the raw
 * reason for display, falling back to a generic message when empty.
 */
function deriveCashoutFailureReason(rawReason: string | null): string {
  const trimmed = rawReason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Cashout failed";
}

function formatAmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Count rows per source for the given user. The Dashboard / Exchange /
 * Staking pages use this to render the "Showing N of X transactions"
 * hint next to the "See all" button. Indexed COUNT(*) queries — much
 * cheaper than re-fetching the full activity feed just to count it.
 *
 * Returned counts are pre-aggregated by surface group:
 *   • `exchange`  = trades + cashouts + swaps
 *   • `staking`   = stake / unstake / claim / emergency_withdraw
 *   • `total`     = exchange + staking
 */
export async function getActivityCountAction(): Promise<
  | {
      success: true;
      data: { exchange: number; staking: number; total: number };
    }
  | { success: false; error: string }
> {
  const session = await getServerSession();
  if (!session) return { success: false, error: "Not authenticated" };

  const userId = session.userId;
  try {
    const [tradesRes, cashoutsRes, swapsRes, stakingRes, onrampsRes] =
      await Promise.all([
        safe(
          () =>
            db.query<RowDataPacket[]>(
              "SELECT COUNT(*) AS cnt FROM trade_orders WHERE user_id = ?",
              [userId]
            ),
          [[{ cnt: 0 } as RowDataPacket], [] as FieldPacket[]] as [RowDataPacket[], FieldPacket[]]
        ),
        safe(
          () =>
            db.query<RowDataPacket[]>(
              "SELECT COUNT(*) AS cnt FROM cashout_orders WHERE user_id = ?",
              [userId]
            ),
          [[{ cnt: 0 } as RowDataPacket], [] as FieldPacket[]] as [RowDataPacket[], FieldPacket[]]
        ),
        safe(
          // Exclude swaps that are the chained second leg of a non-USD
          // stable top-up OR of a non-USD ↔ PLAT Convert. Both surface
          // as a single user-facing row from their parent table, so
          // counting them here would double-count. NOT EXISTS keeps the
          // query index-friendly.
          () =>
            db.query<RowDataPacket[]>(
              `SELECT COUNT(*) AS cnt
               FROM swap_transactions s
               WHERE s.user_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM onramp_orders o
                   WHERE o.target_swap_transaction_id = s.transaction_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM trade_orders t
                   WHERE t.order_type = 'convert'
                     AND t.payout_swap_transaction_id = s.transaction_id
                 )`,
              [userId]
            ),
          [[{ cnt: 0 } as RowDataPacket], [] as FieldPacket[]] as [RowDataPacket[], FieldPacket[]]
        ),
        safe(
          // Count raw staking orders + one extra row per unstake-with-
          // rewards. The dApp splits those into two activity entries
          // ("Withdraw Deposit" + "Collect Rewards"), so the visible
          // row count for "Showing N of X" must include that extra row.
          () =>
            db.query<RowDataPacket[]>(
              `SELECT COUNT(*) + SUM(
                 CASE WHEN order_type = 'unstake' AND reward_amount >= ?
                   THEN 1 ELSE 0 END
               ) AS cnt
               FROM staking_orders WHERE user_id = ?`,
              [DUST_REWARD_THRESHOLD, userId]
            ),
          [[{ cnt: 0 } as RowDataPacket], [] as FieldPacket[]] as [RowDataPacket[], FieldPacket[]]
        ),
        safe(
          // Stable top-ups (standalone on-ramp with a target_token). NULL
          // target_token rows are the legacy / orphan onramp page and are
          // never surfaced in the new Buy flow, so excluding them keeps
          // the count aligned with what loadActivity actually returns.
          () =>
            db.query<RowDataPacket[]>(
              `SELECT COUNT(*) AS cnt
               FROM onramp_orders
               WHERE user_id = ? AND target_token IS NOT NULL`,
              [userId]
            ),
          [[{ cnt: 0 } as RowDataPacket], [] as FieldPacket[]] as [RowDataPacket[], FieldPacket[]]
        ),
      ]);

    const trades = Number(tradesRes[0]?.[0]?.cnt) || 0;
    const cashouts = Number(cashoutsRes[0]?.[0]?.cnt) || 0;
    const swaps = Number(swapsRes[0]?.[0]?.cnt) || 0;
    const staking = Number(stakingRes[0]?.[0]?.cnt) || 0;
    const onramps = Number(onrampsRes[0]?.[0]?.cnt) || 0;

    const exchange = trades + cashouts + swaps + onramps;
    return {
      success: true,
      data: { exchange, staking, total: exchange + staking },
    };
  } catch (err) {
    console.error("[dashboard] getActivityCountAction failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to count activity",
    };
  }
}
