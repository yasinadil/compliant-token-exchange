// app/lib/chainlink-service.ts
// Oracle Price Feed integration for Base mainnet
// Primary: Chainlink | Fallback: Pyth Network

import { createPublicClient, http, type Address, formatUnits } from "viem";
import { base } from "viem/chains";

// Base mainnet RPC
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Pyth Network Hermes endpoint (free, production-ready)
const PYTH_HERMES_ENDPOINT = "https://hermes.pyth.network";

// ============================================================================
// CHAINLINK CONFIGURATION
// ============================================================================

// Chainlink Price Feed addresses on Base mainnet
// Verify these at: https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
export const CHAINLINK_FEEDS: Record<string, Address> = {
  "EUR/USD": "0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F",
  "GBP/USD": "0xCceA6576904C118037695eB71195a5425E69Fa15",
  "BRL/USD": "0x0b0E64c05083FdF9ED7C5D3d8262c4216eFc9394",
  "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
};

// Chainlink Aggregator V3 ABI (minimal)
const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================================================
// PYTH NETWORK CONFIGURATION
// ============================================================================

// Pyth price feed IDs (hex strings)
// Find more at: https://pyth.network/developers/price-feed-ids
export const PYTH_PRICE_FEED_IDS: Record<string, string> = {
  "EUR/USD": "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
  "GBP/USD": "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1",
  "USD/BRL": "0xd2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906", // Note: Inverse of BRL/USD
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

// Pairs that need to be inverted (Pyth has X/Y but we need Y/X)
const PYTH_INVERSE_PAIRS: Record<string, string> = {
  "BRL/USD": "USD/BRL", // We need BRL/USD but Pyth has USD/BRL
};

// ============================================================================
// TYPES
// ============================================================================

export interface PriceData {
  price: number;
  decimals: number;
  roundId: string;
  updatedAt: Date;
  feedAddress: Address;
  blockNumber: bigint;
  source: "chainlink" | "pyth";
}

// ============================================================================
// CLIENTS
// ============================================================================

function getViemClient() {
  return createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });
}


// ============================================================================
// CHAINLINK ORACLE
// ============================================================================

async function getChainlinkPriceInternal(pair: string): Promise<PriceData | null> {
  const feedAddress = CHAINLINK_FEEDS[pair];
  
  if (!feedAddress || feedAddress === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  try {
    const client = getViemClient();
    const blockNumber = await client.getBlockNumber();

    const decimals = await client.readContract({
      address: feedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    });

    const [roundId, answer, , updatedAt] = await client.readContract({
      address: feedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    });

    const price = Number(formatUnits(answer, decimals));

    // Sanity check - price should be positive and reasonable
    if (price <= 0 || price > 1000) {
      console.warn(`Chainlink returned suspicious price for ${pair}: ${price}`);
      return null;
    }

    return {
      price,
      decimals,
      roundId: roundId.toString(),
      updatedAt: new Date(Number(updatedAt) * 1000),
      feedAddress,
      blockNumber,
      source: "chainlink",
    };
  } catch (error) {
    console.error(`Chainlink failed for ${pair}:`, error);
    return null;
  }
}

// ============================================================================
// PYTH NETWORK ORACLE
// ============================================================================

interface PythPriceResponse {
  parsed: Array<{
    id: string;
    price: {
      price: string;
      expo: number;
      publish_time: number;
    };
  }>;
}

async function getPythPriceInternal(pair: string): Promise<PriceData | null> {
  // Check if we need to use an inverse pair
  const inversePair = PYTH_INVERSE_PAIRS[pair];
  const pythPair = inversePair || pair;
  const needsInverse = !!inversePair;
  
  const feedId = PYTH_PRICE_FEED_IDS[pythPair];
  
  if (!feedId) {
    return null;
  }

  try {
    // Use Pyth Hermes HTTP API directly
    const cleanFeedId = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
    const url = `${PYTH_HERMES_ENDPOINT}/v2/updates/price/latest?ids[]=${cleanFeedId}`;
    
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
      next: { revalidate: 10 }, // Cache for 10 seconds
    });

    if (!response.ok) {
      console.warn(`Pyth API returned ${response.status} for ${pythPair}`);
      return null;
    }

    const data: PythPriceResponse = await response.json();

    if (!data.parsed || data.parsed.length === 0) {
      return null;
    }

    const priceFeed = data.parsed[0];
    const priceInfo = priceFeed.price;
    
    // Check staleness (max 60 seconds old)
    const now = Math.floor(Date.now() / 1000);
    if (now - priceInfo.publish_time > 60) {
      console.warn(`Pyth price too stale for ${pythPair}`);
      return null;
    }

    // Pyth prices are in a fixed-point format
    let price = Number(priceInfo.price) * Math.pow(10, priceInfo.expo);

    // If we used an inverse pair (e.g., USD/BRL for BRL/USD), invert the price
    if (needsInverse) {
      price = 1 / price;
      console.log(`[Pyth] Inverted ${pythPair} (${1/price}) to get ${pair} (${price})`);
    }

    // Sanity check
    if (price <= 0 || price > 1000) {
      console.warn(`Pyth returned suspicious price for ${pair}: ${price}`);
      return null;
    }

    return {
      price,
      decimals: Math.abs(priceInfo.expo),
      roundId: priceFeed.id,
      updatedAt: new Date(priceInfo.publish_time * 1000),
      feedAddress: "0x0000000000000000000000000000000000000000" as Address,
      blockNumber: BigInt(0),
      source: "pyth",
    };
  } catch (error) {
    console.error(`Pyth failed for ${pair}:`, error);
    return null;
  }
}

// ============================================================================
// UNIFIED PRICE FETCHER (with fallback chain)
// ============================================================================

/**
 * Get price from oracles with fallback chain:
 * 1. Chainlink (primary)
 * 2. Pyth Network (fallback)
 * 
 * Throws an error if both oracles are unavailable.
 */
export async function getOraclePrice(pair: string): Promise<PriceData> {
  // Try Chainlink first
  const chainlinkPrice = await getChainlinkPriceInternal(pair);
  if (chainlinkPrice) {
    console.log(`[Oracle] ${pair}: Using Chainlink - $${chainlinkPrice.price.toFixed(4)}`);
    return chainlinkPrice;
  }

  // Try Pyth as fallback
  const pythPrice = await getPythPriceInternal(pair);
  if (pythPrice) {
    console.log(`[Oracle] ${pair}: Using Pyth (fallback) - $${pythPrice.price.toFixed(4)}`);
    return pythPrice;
  }

  // Both oracles failed - throw error
  console.error(`[Oracle] CRITICAL: Both Chainlink and Pyth unavailable for ${pair}`);
  throw new Error(
    `Price feed unavailable: Unable to fetch ${pair} rate from any oracle. Please try again later.`
  );
}

// Legacy alias for backwards compatibility
export const getChainlinkPrice = getOraclePrice;

// ============================================================================
// TOKEN RATE HELPERS
// ============================================================================

/**
 * Get USD rate for a T Fiat token
 * USDX = 1 USD (base)
 * GBPX = GBP/USD rate
 * EURX = EUR/USD rate
 * BRLX = BRL/USD rate
 */
export async function getTokenUSDRate(tokenSymbol: string): Promise<{
  rate: number;
  priceData: PriceData | null;
}> {
  // USDX is pegged 1:1 to USD
  if (tokenSymbol === "USDX") {
    return {
      rate: 1,
      priceData: null,
    };
  }

  // Map token to oracle pair
  const pairMap: Record<string, string> = {
    GBPX: "GBP/USD",
    EURX: "EUR/USD",
    BRLX: "BRL/USD",
  };

  const pair = pairMap[tokenSymbol];
  if (!pair) {
    throw new Error(`Unknown token: ${tokenSymbol}`);
  }

  const priceData = await getOraclePrice(pair);

  return {
    rate: priceData.price,
    priceData,
  };
}

/**
 * Calculate swap rate between two T Fiat tokens
 * Returns how much of toToken you get for 1 unit of fromToken
 */
export async function calculateSwapRate(
  fromToken: string,
  toToken: string
): Promise<{
  rate: number;
  fromUSDRate: number;
  toUSDRate: number;
  fromPriceData: PriceData | null;
  toPriceData: PriceData | null;
}> {
  // Get USD rates for both tokens
  const fromData = await getTokenUSDRate(fromToken);
  const toData = await getTokenUSDRate(toToken);

  // Calculate exchange rate
  const rate = fromData.rate / toData.rate;

  return {
    rate,
    fromUSDRate: fromData.rate,
    toUSDRate: toData.rate,
    fromPriceData: fromData.priceData,
    toPriceData: toData.priceData,
  };
}

/**
 * Get all current T Fiat rates
 */
export async function getAllRates(): Promise<
  Record<string, { rate: number; priceData: PriceData | null }>
> {
  const tokens = ["USDX", "GBPX", "EURX", "BRLX"];
  const rates: Record<string, { rate: number; priceData: PriceData | null }> = {};

  for (const token of tokens) {
    try {
      rates[token] = await getTokenUSDRate(token);
    } catch (error) {
      console.error(`Failed to get rate for ${token}:`, error);
      rates[token] = { rate: 1, priceData: null };
    }
  }

  return rates;
}

/**
 * Get oracle health status
 */
export async function getOracleHealth(): Promise<{
  chainlink: boolean;
  pyth: boolean;
  activePair: string;
}> {
  const testPair = "EUR/USD";
  
  const chainlinkOk = (await getChainlinkPriceInternal(testPair)) !== null;
  const pythOk = (await getPythPriceInternal(testPair)) !== null;

  return {
    chainlink: chainlinkOk,
    pyth: pythOk,
    activePair: testPair,
  };
}
