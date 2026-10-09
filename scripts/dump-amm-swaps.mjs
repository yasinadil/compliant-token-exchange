// scripts/dump-amm-swaps.mjs
//
// Diagnostic for the PLAT price chart. Lists every AMM Swap event in
// the last 7 days, in order, with both spotPriceBefore and spotPriceAfter.
// This is what `getPlatSpotPriceHistory` indexes — if the FIRST event
// in the window has `spotPriceBefore = 0.74` (not 0.73 as we'd expect),
// the chart's leading-zero backfill correctly fills earlier days with
// 0.74 and the chart looks flat at 0.74. Not a bug — just an older swap
// we didn't account for.
//
// Usage:
//   node scripts/dump-amm-swaps.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatUnits, parseAbiItem } from "viem";
import { base } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const envPath = path.join(projectRoot, ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error(`[dump-amm-swaps] .env.local not found at ${envPath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  const env = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnvLocal();

// Pull the AMM address from the same source the app uses.
const addressesModule = await import(
  "file://" +
    path.join(projectRoot, "config", "addresses.ts").replace(/\\/g, "/")
).catch(async () => {
  // .ts can't be imported directly by node without a loader, so fall
  // back to reading the file and pulling the AMM address out of it.
  const src = fs.readFileSync(
    path.join(projectRoot, "config", "addresses.ts"),
    "utf8"
  );
  const m = src.match(/AMM[^"']*["']([0-9a-fA-Fx]+)["']/);
  if (!m) {
    console.error("[dump-amm-swaps] couldn't find AMM address in addresses.ts");
    process.exit(1);
  }
  return { addresses: { AMM: m[1] } };
});

const AMM = addressesModule.addresses.AMM;

// Mirror the app's `getLogsClient` — use the same RPC the chart now uses.
const rpc =
  env.BASE_LOGS_RPC_URL ||
  "https://mainnet.base.org";
console.log(`[dump-amm-swaps] RPC: ${rpc.replace(/\/v2\/.+$/, "/v2/***")}`);
const client = createPublicClient({
  chain: base,
  transport: http(rpc),
});

const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed user, bool assetIn, uint256 amountIn, uint256 amountOut, uint256 feeAmount, uint256 spotPriceBefore, uint256 spotPriceAfter, uint256 slippageBps)"
);

const head = await client.getBlockNumber();
const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const SECONDS_PER_BLOCK = 2;
const blocksToScan = BigInt(Math.ceil(SEVEN_DAYS_SEC / SECONDS_PER_BLOCK));
const fromBlock = head > blocksToScan ? head - blocksToScan : 0n;

console.log(`[dump-amm-swaps] AMM: ${AMM}`);
console.log(`[dump-amm-swaps] head: ${head}, from: ${fromBlock} (≈ 7 days)`);

const CHUNK = 9000n;
const allLogs = [];
let cur = fromBlock;
while (cur <= head) {
  const end = cur + CHUNK - 1n > head ? head : cur + CHUNK - 1n;
  try {
    const logs = await client.getLogs({
      address: AMM,
      event: SWAP_EVENT,
      fromBlock: cur,
      toBlock: end,
    });
    allLogs.push(...logs);
  } catch (err) {
    console.warn(`  chunk ${cur}-${end} failed: ${err.message}`);
  }
  cur = end + 1n;
}

console.log(`\n[dump-amm-swaps] Found ${allLogs.length} Swap events in window.\n`);

if (allLogs.length === 0) {
  console.log("  (none — chart would use flat-line fallback at live spot)");
  process.exit(0);
}

const blocks = new Map();
await Promise.all(
  Array.from(new Set(allLogs.map((l) => l.blockNumber))).map(async (bn) => {
    const b = await client.getBlock({ blockNumber: bn });
    blocks.set(bn, Number(b.timestamp));
  })
);

const points = allLogs
  .map((l) => ({
    block: l.blockNumber,
    tsSec: blocks.get(l.blockNumber),
    priceBefore: Number(formatUnits(l.args.spotPriceBefore, 18)),
    priceAfter: Number(formatUnits(l.args.spotPriceAfter, 18)),
    tglobalIn: l.args.assetIn,
  }))
  .sort((a, b) => a.tsSec - b.tsSec);

console.log("  block       UTC time                  before    after    direction");
console.log("  ─────────── ───────────────────────── ─────── ─────── ─────────────");
for (const p of points) {
  const dt = new Date(p.tsSec * 1000).toISOString().replace("T", " ").slice(0, 19);
  const dir = p.tglobalIn ? "SELL PLAT" : "BUY PLAT";
  console.log(
    `  ${String(p.block).padEnd(11)} ${dt}Z    ${p.priceBefore.toFixed(4)}  ${p.priceAfter.toFixed(4)}  ${dir}`
  );
}

console.log("");
console.log(
  `[dump-amm-swaps] First swap's priceBefore = ${points[0].priceBefore.toFixed(
    4
  )} → chart backfills the 6 quiet days BEFORE the first swap with this value.`
);

const liveSpot = await client.readContract({
  address: AMM,
  abi: [
    {
      type: "function",
      name: "getSpotPrice",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint256" }],
    },
  ],
  functionName: "getSpotPrice",
});
console.log(
  `[dump-amm-swaps] Live spot now = ${Number(formatUnits(liveSpot, 18)).toFixed(4)} (the last bucket gets anchored to this).`
);
