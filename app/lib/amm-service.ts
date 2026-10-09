// app/lib/amm-service.ts
// Read-only service for AMM vault, compliance, impact policy, and timelock contracts
import { createPublicClient, http, type Address, formatUnits } from "viem";
import { base } from "viem/chains";
import { addresses } from "@/config/addresses";
import { AMM_ABI } from "@/config/ABI/AMM_ABI";
import { COMPLIANCE_REGISTRY_ABI } from "@/config/ABI/COMPLIANCE_REGISTRY_ABI";
import { IMPACT_POLICY_ABI } from "@/config/ABI/IMPACT_POLICY_ABI";
import { TIME_LOCK_ABI } from "@/config/ABI/TIME_LOCK_ABI";
import { USDX_ABI } from "@/config/ABI/USDX_ABI";
import { PLAT_ABI } from "@/config/ABI/PLAT_ABI";

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Dedicated RPC URL for `eth_getLogs` scans (the chart's 7-day Swap-event
// index). The primary `BASE_RPC_URL` is often Alchemy, whose free tier
// caps `eth_getLogs` to a 10-block range — breaks our 9,000-block chunks
// and silently zeroes out the chart (every chunk fails → `allLogs` empty
// → `flatFallback` paints the live spot across every day). Public Base
// RPC permits 10,000-block ranges, which is what the chunking is tuned
// for. Operators can override with `BASE_LOGS_RPC_URL`.
const BASE_LOGS_RPC_URL =
  process.env.BASE_LOGS_RPC_URL || "https://mainnet.base.org";

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });
}

function getLogsClient() {
  return createPublicClient({
    chain: base,
    transport: http(BASE_LOGS_RPC_URL),
  });
}

export const POOL_PHASES = [
  "UNINITIALIZED",
  "SEED",
  "ACTIVE",
  "PAUSED",
  "DEPRECATED",
] as const;
export type PoolPhase = (typeof POOL_PHASES)[number];

export interface PoolInfo {
  phase: PoolPhase;
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

export interface SwapQuote {
  amountOut: string;
  priceImpactBps: number;
  feeAmount: string;
  effectivePrice: string;
  spotPrice: string;
}

export interface ComplianceInfo {
  isCompliant: boolean;
  tier: number;
  dailyLimit: string;
  remainingDailyLimit: string;
}

export interface ImpactPolicyInfo {
  paused: boolean;
  tier0MaxSlippage: number;
  tier1MaxSlippage: number;
  tier2MaxSlippage: number;
  tier3MaxSlippage: number;
  tier1Threshold: string;
  tier2Threshold: string;
  tier3Threshold: string;
}

export interface TimelockOperation {
  id: string;
  target: string;
  value: string;
  data: string;
  queuedAt: number;
  executeAfter: number;
  status: number;
  description: string;
}

export interface TimelockInfo {
  delay: number;
  minDelay: number;
  maxDelay: number;
  gracePeriod: number;
  operationCount: number;
  pendingOperations: TimelockOperation[];
}

export interface TokenBalances {
  tusd: string;
  tglobal: string;
  tusdAllowance: string;
  tglobalAllowance: string;
}

// ============ POOL INFO ============

export async function getPoolInfo(): Promise<PoolInfo> {
  const client = getPublicClient();
  const amm = addresses.AMM as Address;

  const [phase, reserves, spotPrice, swapFeeBps, poolStats, paused, k] =
    await Promise.all([
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "phase",
      }),
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "getReserves",
      }),
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "getSpotPrice",
      }),
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "swapFeeBps",
      }),
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "getPoolStats",
      }),
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "paused",
      }),
      client.readContract({
        address: amm,
        abi: AMM_ABI,
        functionName: "getK",
      }),
    ]);

  const [reserveAsset, reserveStable] = reserves as [bigint, bigint];
  const [totalVolumeUSD, totalSwapCount, accFeesAsset, accFeesUsdx] =
    poolStats as [bigint, bigint, bigint, bigint, bigint];

  return {
    phase: POOL_PHASES[phase as number],
    reservePLAT: formatUnits(reserveAsset, 18),
    reserveStable: formatUnits(reserveStable, 18),
    spotPrice: formatUnits(spotPrice as bigint, 18),
    swapFeeBps: Number(swapFeeBps),
    totalVolumeUSD: formatUnits(totalVolumeUSD, 18),
    totalSwapCount: Number(totalSwapCount),
    accumulatedFeesPLAT: formatUnits(accFeesAsset, 18),
    accumulatedFeesStable: formatUnits(accFeesUsdx, 18),
    paused: paused as boolean,
    k: (k as bigint).toString(),
  };
}

// ============ PRICE HISTORY (Swap event indexing) ============

/**
 * 7-day (or N-day) PLAT spot-price history, reconstructed from the
 * AMM's `Swap` events on Base. The event already encodes
 * `spotPriceAfter` so we don't need to recompute anything from
 * reserves — just pair each log with its block timestamp.
 *
 * Returns one price sample per day for `days` days, ordered oldest →
 * newest. Days with no trading activity carry the previous day's
 * closing price forward (sticky-fill). The last bucket is anchored to
 * the current `getSpotPrice()` so the chart's right edge always
 * matches the live headline.
 *
 * On any RPC failure we still return a flat-line series anchored to
 * the live spot price — a real number is more useful in the UI than
 * a "history unavailable" placeholder. Returns `null` only if even
 * the live spot read fails.
 */
const SWAP_EVENT_ABI = {
  type: "event",
  name: "Swap",
  inputs: [
    { indexed: true, name: "user", type: "address" },
    { indexed: false, name: "assetIn", type: "bool" },
    { indexed: false, name: "amountIn", type: "uint256" },
    { indexed: false, name: "amountOut", type: "uint256" },
    { indexed: false, name: "feeAmount", type: "uint256" },
    { indexed: false, name: "spotPriceBefore", type: "uint256" },
    { indexed: false, name: "spotPriceAfter", type: "uint256" },
    { indexed: false, name: "slippageBps", type: "uint256" },
  ],
} as const;

/**
 * PLAT spot-price history. Two modes:
 *   • `"day"`   → 7 buckets, one per UTC day. Used by the dashboard's
 *                 default "1D" view.
 *   • `"hour"`  → 24 buckets, one per hour, hour-aligned. Used by the
 *                 "1H" view — captures same-day moves the daily bucketing
 *                 collapses (e.g. a buy-then-revert that nets out by EOD).
 *
 * Both modes share the same on-chain `Swap` event indexing + sticky-fill
 * + leading-zero backfill logic; only the bucket size + count differ.
 */
export type SpotPriceGranularity = "day" | "hour";

const PRICE_HISTORY_CACHE_TTL_MS = 30_000;
const priceHistoryCache: Partial<
  Record<SpotPriceGranularity, { value: number[]; expiresAt: number }>
> = {};
const priceHistoryInFlight: Partial<
  Record<SpotPriceGranularity, Promise<number[] | null>>
> = {};

export async function getPlatSpotPriceHistory(
  granularity: SpotPriceGranularity = "day"
): Promise<number[] | null> {
  const cached = priceHistoryCache[granularity];
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const inFlight = priceHistoryInFlight[granularity];
  if (inFlight) {
    return inFlight;
  }

  const request = loadPlatSpotPriceHistory(granularity)
    .then((value) => {
      if (value) {
        priceHistoryCache[granularity] = {
          value,
          expiresAt: Date.now() + PRICE_HISTORY_CACHE_TTL_MS,
        };
      }
      return value;
    })
    .finally(() => {
      if (priceHistoryInFlight[granularity] === request) {
        delete priceHistoryInFlight[granularity];
      }
    });

  priceHistoryInFlight[granularity] = request;
  return request;
}

async function loadPlatSpotPriceHistory(
  granularity: SpotPriceGranularity
): Promise<number[] | null> {
  const client = getPublicClient();
  // Separate client for `eth_getLogs` — see `getLogsClient` for why we
  // don't reuse the primary RPC here (Alchemy free tier caps logs to
  // a 10-block range, which silently empties this scan).
  const logsClient = getLogsClient();
  const amm = addresses.AMM as Address;

  const bucketCount = granularity === "day" ? 7 : 24;
  const bucketSeconds = granularity === "day" ? 86400 : 3600;

  // Base public RPC caps `eth_getLogs` at 10,000 blocks per request,
  // so we chunk the lookback window. 9,000 leaves headroom under the
  // cap. ~2s/block on Base → 9,000 blocks ≈ 5 hours of history per
  // chunk, so 7 days ≈ ~34 chunks; 24 hours ≈ ~5 chunks. Sequential
  // to avoid bursty load.
  const SECONDS_PER_BLOCK = 2;
  const CHUNK_SIZE = BigInt(9000);
  const totalSeconds = bucketCount * bucketSeconds;
  const blocksToScan = BigInt(Math.ceil(totalSeconds / SECONDS_PER_BLOCK));

  // Always read the live spot price first — it's the fallback if the
  // log scan fails AND the anchor for the last bucket on success.
  let liveSpotF: number | null = null;
  try {
    const liveSpot = (await client.readContract({
      address: amm,
      abi: AMM_ABI,
      functionName: "getSpotPrice",
    })) as bigint;
    const v = Number(formatUnits(liveSpot, 18));
    if (Number.isFinite(v) && v > 0) liveSpotF = v;
  } catch (err) {
    console.error("[amm] getSpotPrice read failed:", err);
  }

  // Flat-line fallback: if we never get the live spot, can't render
  // anything meaningful. If we do, at minimum we'll fill the chart
  // with that one value (no time series, but a real number).
  const flatFallback = (): number[] | null =>
    liveSpotF != null
      ? Array.from({ length: bucketCount }, () => liveSpotF as number)
      : null;

  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch (err) {
    console.error("[amm] getBlockNumber failed:", err);
    return flatFallback();
  }
  const fromBlock = head > blocksToScan ? head - blocksToScan : BigInt(0);

  // Collect logs across all chunks. A chunk failure is logged but does
  // not abort the scan — a partial window still produces a better
  // chart than the placeholder.
  type SwapLog = Awaited<ReturnType<typeof client.getLogs<typeof SWAP_EVENT_ABI>>>[number];
  const allLogs: SwapLog[] = [];
  let chunkStart = fromBlock;
  while (chunkStart <= head) {
    const chunkEnd =
      chunkStart + CHUNK_SIZE - BigInt(1) > head
        ? head
        : chunkStart + CHUNK_SIZE - BigInt(1);
    try {
      const chunkLogs = await logsClient.getLogs({
        address: amm,
        event: SWAP_EVENT_ABI,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      allLogs.push(...chunkLogs);
    } catch (err) {
      console.warn(
        `[amm] getLogs chunk ${chunkStart}-${chunkEnd} failed (skipping):`,
        err instanceof Error ? err.message : err
      );
    }
    chunkStart = chunkEnd + BigInt(1);
  }

  // If every chunk failed and we have no logs, fall back to flat line.
  if (allLogs.length === 0) {
    return flatFallback();
  }

  // Resolve block timestamps. Dedupe so we don't refetch the same
  // block for swaps that share it.
  const uniqueBlocks = Array.from(
    new Set(allLogs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))
  );
  const blockTimestamps = new Map<bigint, number>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      try {
        const b = await client.getBlock({ blockNumber: bn });
        blockTimestamps.set(bn, Number(b.timestamp));
      } catch (err) {
        console.warn(`[amm] getBlock ${bn} failed:`, err);
      }
    })
  );

  interface PricePoint {
    tsSec: number;
    /** `spotPriceAfter` — the AMM price right AFTER this swap landed. */
    price: number;
    /** `spotPriceBefore` — the AMM price right BEFORE this swap. Used
     *  for pre-history backfill: days that elapsed before any observed
     *  swap had the first swap's `priceBefore`, NOT the current live
     *  spot. Without this, a single test trade rewrites every earlier
     *  day in the chart to the post-trade price. */
    priceBefore: number | null;
  }
  const points: PricePoint[] = [];
  for (const log of allLogs) {
    if (log.blockNumber == null) continue;
    const ts = blockTimestamps.get(log.blockNumber);
    if (ts == null) continue;
    const post = log.args?.spotPriceAfter;
    if (post == null) continue;
    const price = Number(formatUnits(post, 18));
    if (!Number.isFinite(price) || price <= 0) continue;
    const pre = log.args?.spotPriceBefore;
    const priceBeforeNum =
      pre != null ? Number(formatUnits(pre, 18)) : NaN;
    const priceBefore =
      Number.isFinite(priceBeforeNum) && priceBeforeNum > 0
        ? priceBeforeNum
        : null;
    points.push({ tsSec: ts, price, priceBefore });
  }
  points.sort((a, b) => a.tsSec - b.tsSec);

  // Bucket the swap events into `bucketCount` evenly-sized buckets. For
  // each bucket we take the last swap inside it; buckets with no swap
  // inherit the previous bucket's value (sticky-fill). For daily mode
  // buckets are UTC days; for hourly mode they're hour-aligned windows
  // ending at the current top-of-hour.
  const nowSec = Math.floor(Date.now() / 1000);
  const startOfCurrentBucketSec = nowSec - (nowSec % bucketSeconds);
  const series: number[] = [];
  let lastKnown: number | null = null;

  for (let i = bucketCount - 1; i >= 0; i--) {
    const dayStart = startOfCurrentBucketSec - i * bucketSeconds;
    const dayEnd = dayStart + bucketSeconds;
    let bucketPrice: number | null = null;
    for (const p of points) {
      if (p.tsSec >= dayStart && p.tsSec < dayEnd) {
        bucketPrice = p.price;
      }
    }
    if (bucketPrice == null) {
      if (lastKnown == null) {
        for (const p of points) {
          if (p.tsSec < dayStart) lastKnown = p.price;
        }
      }
      bucketPrice = lastKnown;
    } else {
      lastKnown = bucketPrice;
    }
    series.push(bucketPrice ?? 0);
  }

  // Backfill leading zeros (days that elapsed BEFORE the first observed
  // swap) with the first swap's `spotPriceBefore` — that's the actual
  // historical AMM price for those days. Falling back to the live spot
  // here is wrong: it rewrites pre-trade history to the post-trade price,
  // which is exactly the bug where a single test purchase makes every
  // earlier day in the 7-day chart "shift up" together.
  //
  // If we don't have a `priceBefore` (older clients / missing field), the
  // first swap's `spotPriceAfter` is the next-best stand-in — the price
  // didn't move between then and `priceBefore`, but at least it's not the
  // post-anchor live spot.
  const firstPoint = points[0];
  const preHistoryPrice =
    firstPoint?.priceBefore ?? firstPoint?.price ?? liveSpotF;
  if (preHistoryPrice != null) {
    for (let i = 0; i < series.length; i++) {
      if (series[i] !== 0) break;
      series[i] = preHistoryPrice;
    }
  }

  // Anchor the last bucket to the live spot so it matches the headline.
  // Any remaining zeros (gaps in the middle — extremely unlikely given the
  // sticky-fill in the bucketing loop) also fall back to the live spot,
  // since by that point we have no better signal.
  if (liveSpotF != null) {
    series[series.length - 1] = liveSpotF;
    for (let i = 0; i < series.length; i++) {
      if (series[i] === 0) series[i] = liveSpotF;
    }
  }

  return series;
}

// ============ QUOTES ============

export async function quoteSwap(
  tglobalIn: boolean,
  amountIn: bigint
): Promise<SwapQuote> {
  const client = getPublicClient();
  const amm = addresses.AMM as Address;

  const [quoteResult, spotPrice, swapFeeBps] = await Promise.all([
    client.readContract({
      address: amm,
      abi: AMM_ABI,
      functionName: "quoteSwap",
      args: [tglobalIn, amountIn],
    }),
    client.readContract({
      address: amm,
      abi: AMM_ABI,
      functionName: "getSpotPrice",
    }),
    client.readContract({
      address: amm,
      abi: AMM_ABI,
      functionName: "swapFeeBps",
    }),
  ]);

  const [amountOut, priceImpactBps] = quoteResult as [bigint, bigint];
  const feeAmount = (amountIn * (swapFeeBps as bigint)) / BigInt(10000);

  const amountInFloat = Number(formatUnits(amountIn, 18));
  const amountOutFloat = Number(formatUnits(amountOut, 18));

  // effectivePrice: how many USDX per 1 PLAT at this trade size
  let effectivePrice = "0";
  if (amountInFloat > 0 && amountOutFloat > 0) {
    if (tglobalIn) {
      // selling PLAT -> USDX: price = USDX_out / PLAT_in
      effectivePrice = (amountOutFloat / amountInFloat).toFixed(6);
    } else {
      // buying PLAT with USDX: price = USDX_in / PLAT_out
      effectivePrice = (amountInFloat / amountOutFloat).toFixed(6);
    }
  }

  return {
    amountOut: formatUnits(amountOut, 18),
    priceImpactBps: Number(priceImpactBps),
    feeAmount: formatUnits(feeAmount, 18),
    effectivePrice,
    spotPrice: formatUnits(spotPrice as bigint, 18),
  };
}

// ============ TOKEN BALANCES ============

export async function getTokenBalances(
  userAddress: string
): Promise<TokenBalances> {
  const client = getPublicClient();
  const addr = userAddress as Address;
  const ammAddr = addresses.AMM as Address;

  const [tusdBal, tglobalBal, tusdAllowance, tglobalAllowance] =
    await Promise.all([
      client.readContract({
        address: addresses.USDX as Address,
        abi: USDX_ABI,
        functionName: "balanceOf",
        args: [addr],
      }),
      client.readContract({
        address: addresses.PLAT as Address,
        abi: PLAT_ABI as any,
        functionName: "balanceOf",
        args: [addr],
      }),
      client.readContract({
        address: addresses.USDX as Address,
        abi: USDX_ABI,
        functionName: "allowance",
        args: [addr, ammAddr],
      }),
      client.readContract({
        address: addresses.PLAT as Address,
        abi: PLAT_ABI as any,
        functionName: "allowance",
        args: [addr, ammAddr],
      }),
    ]);

  return {
    tusd: formatUnits(tusdBal as bigint, 18),
    tglobal: formatUnits(tglobalBal as bigint, 18),
    tusdAllowance: formatUnits(tusdAllowance as bigint, 18),
    tglobalAllowance: formatUnits(tglobalAllowance as bigint, 18),
  };
}

// ============ COMPLIANCE ============

export async function getComplianceInfo(
  userAddress: string
): Promise<ComplianceInfo> {
  const client = getPublicClient();
  const registry = addresses.COMPLIANCE_REGISTRY as Address;
  const addr = userAddress as Address;

  const [isCompliant, tier, dailyLimit, remaining] = await Promise.all([
    client.readContract({
      address: registry,
      abi: COMPLIANCE_REGISTRY_ABI,
      functionName: "isCompliant",
      args: [addr],
    }),
    client.readContract({
      address: registry,
      abi: COMPLIANCE_REGISTRY_ABI,
      functionName: "getComplianceTier",
      args: [addr],
    }),
    client.readContract({
      address: registry,
      abi: COMPLIANCE_REGISTRY_ABI,
      functionName: "getDailyLimit",
      args: [addr],
    }),
    client.readContract({
      address: registry,
      abi: COMPLIANCE_REGISTRY_ABI,
      functionName: "getRemainingDailyLimit",
      args: [addr],
    }),
  ]);

  return {
    isCompliant: isCompliant as boolean,
    tier: Number(tier),
    dailyLimit: formatUnits(dailyLimit as bigint, 18),
    remainingDailyLimit: formatUnits(remaining as bigint, 18),
  };
}

// ============ IMPACT POLICY ============

export async function getImpactPolicyInfo(): Promise<ImpactPolicyInfo> {
  const client = getPublicClient();
  const policy = addresses.IMPACT_POLICY as Address;

  const [paused, t0, t1, t2, t3, th1, th2, th3] = await Promise.all([
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "paused",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier0MaxSlippage",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier1MaxSlippage",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier2MaxSlippage",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier3MaxSlippage",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier1ThresholdUSD",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier2ThresholdUSD",
    }),
    client.readContract({
      address: policy,
      abi: IMPACT_POLICY_ABI,
      functionName: "tier3ThresholdUSD",
    }),
  ]);

  return {
    paused: paused as boolean,
    tier0MaxSlippage: Number(t0),
    tier1MaxSlippage: Number(t1),
    tier2MaxSlippage: Number(t2),
    tier3MaxSlippage: Number(t3),
    tier1Threshold: formatUnits(th1 as bigint, 18),
    tier2Threshold: formatUnits(th2 as bigint, 18),
    tier3Threshold: formatUnits(th3 as bigint, 18),
  };
}

// ============ TIMELOCK ============

export async function getTimelockInfo(): Promise<TimelockInfo> {
  const client = getPublicClient();
  const timelock = addresses.TIME_LOCK as Address;

  const [delay, minDelay, maxDelay, gracePeriod, opCount, pendingOps] =
    await Promise.all([
      client.readContract({
        address: timelock,
        abi: TIME_LOCK_ABI,
        functionName: "delay",
      }),
      client.readContract({
        address: timelock,
        abi: TIME_LOCK_ABI,
        functionName: "MIN_DELAY",
      }),
      client.readContract({
        address: timelock,
        abi: TIME_LOCK_ABI,
        functionName: "MAX_DELAY",
      }),
      client.readContract({
        address: timelock,
        abi: TIME_LOCK_ABI,
        functionName: "GRACE_PERIOD",
      }),
      client.readContract({
        address: timelock,
        abi: TIME_LOCK_ABI,
        functionName: "getOperationCount",
      }),
      client.readContract({
        address: timelock,
        abi: TIME_LOCK_ABI,
        functionName: "getPendingOperations",
      }),
    ]);

  const operations = (pendingOps as any[]).map((op: any) => ({
    id: op.id,
    target: op.target,
    value: op.value.toString(),
    data: op.data,
    queuedAt: Number(op.queuedAt),
    executeAfter: Number(op.executeAfter),
    status: Number(op.status),
    description: op.description,
  }));

  return {
    delay: Number(delay),
    minDelay: Number(minDelay),
    maxDelay: Number(maxDelay),
    gracePeriod: Number(gracePeriod),
    operationCount: Number(opCount),
    pendingOperations: operations,
  };
}

// ============ ROLE CHECKS ============

export async function hasAMMRole(
  roleName: string,
  account: string
): Promise<boolean> {
  const client = getPublicClient();
  const amm = addresses.AMM as Address;

  const roleHash = (await client.readContract({
    address: amm,
    abi: AMM_ABI,
    functionName: roleName as any,
  })) as `0x${string}`;

  return (await client.readContract({
    address: amm,
    abi: AMM_ABI,
    functionName: "hasRole",
    args: [roleHash, account as Address],
  })) as boolean;
}

export async function hasTimelockRole(
  roleName: string,
  account: string
): Promise<boolean> {
  const client = getPublicClient();
  const timelock = addresses.TIME_LOCK as Address;

  const roleHash = (await client.readContract({
    address: timelock,
    abi: TIME_LOCK_ABI,
    functionName: roleName as any,
  })) as `0x${string}`;

  return (await client.readContract({
    address: timelock,
    abi: TIME_LOCK_ABI,
    functionName: "hasRole",
    args: [roleHash, account as Address],
  })) as boolean;
}
