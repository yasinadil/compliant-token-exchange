// app/lib/transak-service.ts
// Transak on-ramp integration service

import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createPublicClient, http, formatUnits, type Address } from "viem";
import { baseSepolia, base } from "viem/chains";
import { addresses } from "@/config/addresses";
import { db, adminDb } from "./db";
import { creditBalance, creditBalanceWithConnection, executeSwap } from "./ledger-service";
import { confirmPayment } from "./trade-order-service";
import type { TransakUserData } from "./kyc-helper";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

// ============================================================================
// CONFIGURATION
// ============================================================================

const isProduction = process.env.TRANSAK_ENVIRONMENT === "PRODUCTION";

export const TRANSAK_CONFIG = {
  apiKey: process.env.TRANSAK_API_KEY || "",
  secretKey: process.env.TRANSAK_SECRET_KEY || "",
  apiSecret: process.env.TRANSAK_API_SECRET || "",

  environment: (process.env.TRANSAK_ENVIRONMENT || "STAGING") as "STAGING" | "PRODUCTION",

  treasuryWallet: process.env.TREASURY_WALLET_ADDRESS || "",

  widgetBaseUrl: isProduction
    ? "https://global.transak.com"
    : "https://global-stg.transak.com",

  refreshTokenUrl: isProduction
    ? "https://api.transak.com/partners/api/v2/refresh-token"
    : "https://api-stg.transak.com/partners/api/v2/refresh-token",

  sessionUrl: isProduction
    ? "https://api-gateway.transak.com/api/v2/auth/session"
    : "https://api-gateway-stg.transak.com/api/v2/auth/session",

  referrerDomain: process.env.NEXT_PUBLIC_APP_DOMAIN || "localhost",

  supportedCryptos: ["USDC", "USDT"],
  // Staging uses Base Sepolia (Transak delivers TRNSK test tokens); production uses Base mainnet
  network: isProduction ? "base" : "base",
  defaultFiatCurrency: "USD",
};

// In staging, Transak delivers TRNSK (test token) on Base Sepolia instead of real USDC
export const TRNSK_TOKEN = {
  address: "0xD733D48f2a7F57D4559F98ae07f87Dab595E3523" as Address,
  decimals: 18,
  symbol: "TRNSK",
};

const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function getBaseSepoliaClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA_RPC_URL),
  });
}

/**
 * Check TRNSK token balance on the treasury wallet (Base Sepolia).
 * Useful for verifying that Transak actually delivered test tokens.
 */
export async function getTreasuryTRNSKBalance(): Promise<{
  raw: bigint;
  formatted: string;
  wallet: string;
}> {
  const client = getBaseSepoliaClient();
  const wallet = TRANSAK_CONFIG.treasuryWallet as Address;

  const balance = await client.readContract({
    address: TRNSK_TOKEN.address,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });

  return {
    raw: balance,
    formatted: formatUnits(balance, TRNSK_TOKEN.decimals),
    wallet: TRANSAK_CONFIG.treasuryWallet,
  };
}

/**
 * Verify that TRNSK tokens were received for a specific transaction hash.
 * Parses Transfer event logs from the tx receipt to confirm delivery.
 */
export async function verifyTRNSKReceipt(txHash: string): Promise<{
  verified: boolean;
  amount: string;
  to: string;
}> {
  const client = getBaseSepoliaClient();

  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    // ERC-20 Transfer(address from, address to, uint256 value) topic
    const TRANSFER_TOPIC =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    const treasuryLower = TRANSAK_CONFIG.treasuryWallet.toLowerCase();

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === TRNSK_TOKEN.address.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC
      ) {
        const toAddress = "0x" + (log.topics[2]?.slice(26) ?? "");
        if (toAddress.toLowerCase() === treasuryLower) {
          const value = BigInt(log.data);
          return {
            verified: true,
            amount: formatUnits(value, TRNSK_TOKEN.decimals),
            to: toAddress,
          };
        }
      }
    }

    return { verified: false, amount: "0", to: "" };
  } catch (error) {
    console.error("[Transak] Failed to verify TRNSK receipt:", error);
    return { verified: false, amount: "0", to: "" };
  }
}

// ============================================================================
// TYPES
// ============================================================================

export type OnRampStatus = 
  | "pending"      // Order created, waiting for payment
  | "processing"   // Payment received, crypto being sent
  | "completed"    // Crypto received, USDX credited
  | "failed"       // Transaction failed
  | "refunded";    // User refunded

/** PLAT stablecoin a standalone on-ramp order can credit. PLAT is *not* a
 *  valid value here — PLAT purchases go through trade_orders, which has
 *  its own AMM-bound flow. NULL preserves legacy behaviour (USDX credit only). */
export type OnRampTargetToken = "USDX" | "EURX" | "GBPX" | "BRLX";

export interface OnRampOrder {
  id: number;
  order_id: string;
  transak_order_id: string | null;
  user_id: string;
  fiat_currency: string;
  fiat_amount: string;
  crypto_currency: string;
  crypto_amount: string;
  tusd_amount: string;
  /** Set when the user picked a non-default destination token in the Buy form.
   *  NULL means legacy behaviour (USDX-only credit). */
  target_token: OnRampTargetToken | null;
  status: OnRampStatus;
  treasury_tx_hash: string | null;
  credit_transaction_id: string | null;
  /** Set after the post-credit USDX → target_token ledger swap commits. Acts
   *  as the idempotency guard for the swap leg (the webhook may be replayed). */
  target_swap_transaction_id: string | null;
  transak_status: string | null;
  partner_order_id: string | null;
  trade_order_id: string | null;
  failure_reason: string | null;
  webhook_payload: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface OnRampOrderRow extends RowDataPacket, OnRampOrder {}

export interface TransakWebhookPayload {
  eventID: string;
  webhookData: {
    id: string;
    status: string;
    partnerOrderId?: string;
    fiatCurrency: string;
    fiatAmount: number;
    cryptoCurrency: string;
    cryptoAmount: number;
    network: string;
    walletAddress: string;
    transactionHash?: string;
    statusReason?: string;
    createdAt: string;
    updatedAt: string;
    /** Present on some SELL webhooks */
    isBuyOrSell?: "BUY" | "SELL";
  };
}

// ============================================================================
// OFF-RAMP (SELL) CONFIG
// ============================================================================

export interface OffRampCryptoConfig {
  tokenAddress: string;
  tokenSymbol: string;
  decimals: number;
  isProduction: boolean;
  /** Network slug passed to Transak widget */
  networkWidget: string;
}

export function getOffRampCryptoConfig(): OffRampCryptoConfig {
  return {
    tokenAddress: isProduction ? addresses.USDC : addresses.TRNSK,
    tokenSymbol: isProduction ? "USDC" : "TRNSK",
    decimals: isProduction ? 6 : 18,
    isProduction,
    networkWidget: TRANSAK_CONFIG.network,
  };
}

/**
 * Warn when the session URL explicitly encodes BUY-only (Sell disabled in dashboard
 * or wrong product). See https://docs.transak.com/docs/sdk-on-ramp-and-off-ramp
 */
function warnIfWidgetUrlIsBuyOnly(widgetUrl: string): void {
  try {
    const u = new URL(widgetUrl);
    const pa = (u.searchParams.get("productsAvailed") || "").toUpperCase();
    if (pa.includes("BUY") && !pa.includes("SELL")) {
      console.warn(
        "[Transak] Widget URL is BUY-only (productsAvailed=%s). " +
          "Enable Sell in Transak Partner Dashboard (Products → Sell). " +
          "Otherwise productsAvailed=SELL in the session request is ignored.",
        pa
      );
    }
  } catch {
    /* ignore malformed URL */
  }
}

/**
 * Build Transak SELL widget URL for iframe embedding via the session API.
 *
 * IMPORTANT: direct query-param URLs (without a sessionId) are blocked by
 * Transak's X-Frame-Options — they refuse to load inside an iframe.
 * The session API is the ONLY way to get an iframe-embeddable URL.
 *
 * If the widget still opens on the BUY screen, Sell is not enabled for
 * this API key's environment. Fix in the Transak Partner Dashboard:
 *   1. Go to https://dashboard.transak.com
 *   2. Switch to the correct environment (Staging / Production) via the
 *      dropdown in the top-right corner
 *   3. Go to Products → Sell → Enable Sell, set fee %, click Update
 */
export async function createOffRampWidgetUrl(options: {
  partnerOrderId: string;
  partnerCustomerId: string;
  fiatCurrency: string;
  cryptoAmount: string;
  fiatAmount?: number;
  countryCode?: string;
  email?: string;
  userData?: TransakUserData;
}): Promise<string> {
  const amountNum = parseFloat(options.cryptoAmount);
  if (isNaN(amountNum) || amountNum <= 0) {
    throw new Error("Invalid crypto amount for Transak off-ramp");
  }

  const offRamp = getOffRampCryptoConfig();
  const roundedCrypto =
    offRamp.isProduction
      ? Number(amountNum.toFixed(6))
      : Number(amountNum.toFixed(8));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  // Return to the new Exchange (Sell tab) so the user lands back in the
  // Def UI after Transak's KYC + bank flow finishes. The Sell tab parses
  // the `transakDone=1` + walletAddress params and runs the wallet
  // redirection (operator sends crypto on the user's behalf).
  const redirectUrl = `${appUrl}/exchange?mode=sell&transakDone=1&orderId=${encodeURIComponent(options.partnerOrderId)}`;

  const widgetParams: Record<string, unknown> = {
    productsAvailed: "SELL",
    network: TRANSAK_CONFIG.network,
    cryptoCurrencyCode: "USDC",
    cryptoAmount: roundedCrypto,
    fiatCurrency: options.fiatCurrency,
    partnerOrderId: options.partnerOrderId,
    partnerCustomerId: String(options.partnerCustomerId),
    themeColor: "10b981",
    colorMode: "DARK",
    hideMenu: true,
    redirectURL: redirectUrl,
  };

  const cc = options.countryCode?.trim().toUpperCase();
  if (cc && cc.length === 2) {
    widgetParams.countryCode = cc;
  }

  if (options.email) {
    widgetParams.email = options.email;
    widgetParams.isAutoFillUserData = true;
  }

  if (options.userData) {
    widgetParams.userData = options.userData;
    widgetParams.isAutoFillUserData = true;
  }

  const widgetUrl = await createWidgetSession(widgetParams);

  console.log("[Transak] SELL widget URL generated via session API:", widgetUrl);
  warnIfWidgetUrlIsBuyOnly(widgetUrl);
  return widgetUrl;
}

// Status mapping from Transak to our internal status
const TRANSAK_STATUS_MAP: Record<string, OnRampStatus> = {
  "AWAITING_PAYMENT_FROM_USER": "pending",
  "PAYMENT_DONE_MARKED_BY_USER": "processing",
  "PENDING_DELIVERY_FROM_TRANSAK": "processing",
  "ON_HOLD_PENDING_DELIVERY_FROM_TRANSAK": "processing",
  "COMPLETED": "completed",
  "CANCELLED": "failed",
  "FAILED": "failed",
  "REFUNDED": "refunded",
  "EXPIRED": "failed",
};

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

/**
 * Generate a unique partner order ID for tracking
 */
export function generatePartnerOrderId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString("hex");
  return `EXC-${timestamp}-${random}`.toUpperCase();
}

/**
 * Create a new on-ramp order (before Transak widget opens)
 */
export async function createOnRampOrder(
  userId: string,
  fiatCurrency: string,
  fiatAmount: string,
  cryptoCurrency: string = "USDC",
  options?: {
    /** Destination stablecoin. When set and != 'USDX', the webhook handler
     *  chains a ledger swap from the credited USDX into this token. NULL/USD
     *  preserves the legacy USDX-only credit. */
    targetToken?: OnRampTargetToken;
  }
): Promise<{ orderId: string; partnerOrderId: string }> {
  const orderId = crypto.randomBytes(32).toString("hex");
  const partnerOrderId = generatePartnerOrderId();
  const targetToken = options?.targetToken ?? null;

  await db.execute<ResultSetHeader>(
    `INSERT INTO onramp_orders (
      order_id, user_id, partner_order_id, fiat_currency, fiat_amount,
      crypto_currency, crypto_amount, tusd_amount, target_token, status
    ) VALUES (?, ?, ?, ?, ?, ?, '0', '0', ?, 'pending')`,
    [orderId, userId, partnerOrderId, fiatCurrency, fiatAmount, cryptoCurrency, targetToken]
  );

  return { orderId, partnerOrderId };
}

/**
 * Create an on-ramp order linked to a trade order (for buy-flow deficit payment).
 * The trade_order_id column links this onramp order back to the trade order
 * so the webhook can auto-trigger confirmPayment after USDX is credited.
 */
export async function createTradeOnRampOrder(
  userId: string,
  fiatCurrency: string,
  fiatAmount: string,
  tradeOrderId: string,
  cryptoCurrency: string = "USDC"
): Promise<{ orderId: string; partnerOrderId: string }> {
  const orderId = crypto.randomBytes(32).toString("hex");
  const partnerOrderId = generatePartnerOrderId();

  await db.execute<ResultSetHeader>(
    `INSERT INTO onramp_orders (
      order_id, user_id, partner_order_id, trade_order_id,
      fiat_currency, fiat_amount, crypto_currency, crypto_amount, tusd_amount, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', '0', 'pending')`,
    [orderId, userId, partnerOrderId, tradeOrderId, fiatCurrency, fiatAmount, cryptoCurrency]
  );

  return { orderId, partnerOrderId };
}

/**
 * Get an on-ramp order by its internal order_id (UUID/hex).
 */
export async function getOnRampOrderById(
  orderId: string
): Promise<OnRampOrder | null> {
  const [rows] = await db.execute<OnRampOrderRow[]>(
    "SELECT * FROM onramp_orders WHERE order_id = ?",
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Get an on-ramp order by partner order ID
 */
export async function getOrderByPartnerOrderId(
  partnerOrderId: string
): Promise<OnRampOrder | null> {
  const [rows] = await db.execute<OnRampOrderRow[]>(
    "SELECT * FROM onramp_orders WHERE partner_order_id = ?",
    [partnerOrderId]
  );
  return rows[0] || null;
}

/**
 * Get an on-ramp order by Transak order ID
 */
export async function getOrderByTransakId(
  transakOrderId: string
): Promise<OnRampOrder | null> {
  const [rows] = await db.execute<OnRampOrderRow[]>(
    "SELECT * FROM onramp_orders WHERE transak_order_id = ?",
    [transakOrderId]
  );
  return rows[0] || null;
}

/**
 * Get user's on-ramp orders
 */
export async function getUserOnRampOrders(
  userId: string,
  limit: number = 20
): Promise<OnRampOrder[]> {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  
  const [rows] = await db.query<OnRampOrderRow[]>(
    `SELECT * FROM onramp_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId]
  );
  return rows;
}

/**
 * Update order with Transak order ID (called when order is created in Transak)
 */
export async function linkTransakOrder(
  partnerOrderId: string,
  transakOrderId: string
): Promise<void> {
  await db.execute(
    "UPDATE onramp_orders SET transak_order_id = ?, updated_at = NOW() WHERE partner_order_id = ?",
    [transakOrderId, partnerOrderId]
  );
}

/**
 * Cancel a still-unpaid standalone stable on-ramp top-up (the new Buy flow's
 * `target_token IS NOT NULL` orders). User-initiated analogue of the
 * auto-expiry path in `expireInFlightOrders`.
 *
 * `onramp_orders` has no 'cancelled' enum value (pending / processing /
 * completed / failed / refunded), so — exactly like the auto-expiry sweep —
 * we encode the cancellation as status = 'failed' with a 'Cancelled by user'
 * reason, which `mapOnRampStatus` renders as the neutral grey UI pill.
 *
 * No refund is involved: the user hasn't paid Transak yet at this point.
 * The Transak-status safety guard (don't cancel a payment that's already
 * processing/delivered) lives in the calling server action, mirroring
 * `cancelBuyOrderAction`.
 *
 * Scoped defensively to the owning user + status IN ('pending','processing')
 * so a completed/failed order can't be flipped by a stale click.
 */
export async function cancelStableTopUpOrder(
  partnerOrderId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  const [res] = await adminDb.execute<ResultSetHeader>(
    `UPDATE onramp_orders
        SET status = 'failed',
            failure_reason = 'Cancelled by user',
            updated_at = NOW()
      WHERE partner_order_id = ?
        AND user_id = ?
        AND target_token IS NOT NULL
        AND status IN ('pending', 'processing')`,
    [partnerOrderId, userId]
  );
  if ((res.affectedRows ?? 0) === 0) {
    return {
      success: false,
      error: "This order can no longer be cancelled.",
    };
  }
  return { success: true };
}

// ============================================================================
// WEBHOOK PROCESSING
// ============================================================================

/**
 * Legacy HMAC-SHA256 webhook signature verification.
 *
 * Kept ONLY as a fallback for partner accounts still configured to send
 * the old flat-JSON webhook format. Current Transak docs mandate the JWT
 * envelope (`{ data: "<jwt>" }`) verified by `decodeAndVerifyWebhookJwt`
 * below — that is the preferred path.
 *
 * @see https://docs.transak.com/guides/how-to-decrypt-webhook-payload
 * @deprecated Use `decodeAndVerifyWebhookJwt` for new integrations.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  if (!TRANSAK_CONFIG.secretKey) {
    console.warn("[Transak] No secret key configured, skipping signature verification");
    return true; // In staging without secret, skip verification
  }

  const expectedSignature = crypto
    .createHmac("sha256", TRANSAK_CONFIG.secretKey)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Shape of the top-level webhook envelope as documented by Transak.
 * The real order details live inside `data` as a signed JWT.
 */
interface TransakWebhookEnvelope {
  data?: unknown;
}

/**
 * Determine whether a raw webhook body follows the JWT envelope format.
 * Safe to call on arbitrary strings — never throws.
 */
export function isJwtWebhookEnvelope(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody) as TransakWebhookEnvelope;
    return typeof parsed?.data === "string" && (parsed.data as string).split(".").length === 3;
  } catch {
    return false;
  }
}

/**
 * Verify and decode a Transak webhook delivered in the current JWT format.
 *
 * Per Transak's documentation the webhook body is `{ data: "<jwt>" }` where
 * `data` is an HS256 JWT signed with the Partner Access Token. We verify
 * the signature using the same access token our Partner API calls use, so
 * there is no extra secret to configure beyond `TRANSAK_API_SECRET`.
 *
 * Returns the decoded `TransakWebhookPayload` on success or `null` if the
 * body is not a valid JWT envelope / the signature does not verify.
 *
 * @see https://docs.transak.com/guides/how-to-decrypt-webhook-payload
 */
export async function decodeAndVerifyWebhookJwt(
  rawBody: string
): Promise<TransakWebhookPayload | null> {
  let envelope: TransakWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as TransakWebhookEnvelope;
  } catch {
    return null;
  }

  const token = envelope?.data;
  if (typeof token !== "string" || !token) {
    return null;
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.error("[Transak Webhook] Failed to load access token for JWT verification:", err);
    return null;
  }

  try {
    const claims = jwt.verify(token, accessToken, { algorithms: ["HS256"] });
    if (!claims || typeof claims !== "object") {
      console.error("[Transak Webhook] JWT verified but claims are not an object");
      return null;
    }

    const payload = claims as Partial<TransakWebhookPayload>;
    if (!payload.webhookData || !payload.webhookData.id) {
      console.error(
        "[Transak Webhook] JWT claims missing webhookData — claims keys:",
        Object.keys(payload)
      );
      return null;
    }

    return payload as TransakWebhookPayload;
  } catch (err) {
    console.error("[Transak Webhook] JWT verification failed:", err);
    return null;
  }
}

/**
 * Process Transak webhook event
 * This is called when Transak sends us a status update
 */
export async function processTransakWebhook(
  payload: TransakWebhookPayload
): Promise<{ success: boolean; message: string }> {
  const { eventID, webhookData } = payload;
  const transakOrderId = webhookData.id;
  
  console.log(`[Transak Webhook] Processing event ${eventID} for order ${transakOrderId}`);
  console.log(`[Transak Webhook] Status: ${webhookData.status}`);
  
  // Find the order by Transak ID or partner ID
  let order = await getOrderByTransakId(transakOrderId);

  if (!order && webhookData.partnerOrderId) {
    order = await getOrderByPartnerOrderId(webhookData.partnerOrderId);
    if (order) {
      // Link the Transak order ID
      await linkTransakOrder(webhookData.partnerOrderId, transakOrderId);
    }
  }

  if (!order) {
    console.error(`[Transak Webhook] Order not found: ${transakOrderId}`);
    return { success: false, message: "Order not found" };
  }

  // Map Transak status to our internal status
  const newStatus = TRANSAK_STATUS_MAP[webhookData.status] || "processing";

  // In staging, verify that TRNSK tokens actually arrived at the treasury wallet.
  // Runs BEFORE the DB transaction because it hits RPC; the result is only logged.
  if (
    webhookData.status === "COMPLETED" &&
    webhookData.cryptoAmount > 0 &&
    !isProduction &&
    webhookData.transactionHash
  ) {
    try {
      const receipt = await verifyTRNSKReceipt(webhookData.transactionHash);
      if (receipt.verified) {
        console.log(
          `[Transak Webhook] On-chain verified: ${receipt.amount} TRNSK received at ${receipt.to}`
        );
      } else {
        console.warn(
          `[Transak Webhook] On-chain verification failed for tx ${webhookData.transactionHash} — proceeding with webhook amount`
        );
      }
    } catch (verifyErr) {
      console.warn("[Transak Webhook] On-chain verification error (non-blocking):", verifyErr);
    }
  }

  // Single transaction: lock onramp row, update status, credit ledger.
  // `creditBalanceWithConnection` shares this transaction, so either both the
  // onramp row update and the USDX credit commit together or neither does.
  const connection = await db.getConnection();
  let linkedTradeOrderId: string | null = null;
  // Post-commit state for the optional stable-top-up swap leg. Captured inside
  // the transaction (under the row lock) and acted on outside the transaction
  // because `executeSwap` opens its own connection/transaction internally.
  let stableTopUpUserId: string | null = null;
  let stableTopUpTarget: OnRampTargetToken | null = null;
  let stableTopUpAmount: string | null = null;

  try {
    await connection.beginTransaction();

    const [lockedRows] = await connection.execute<OnRampOrderRow[]>(
      "SELECT * FROM onramp_orders WHERE id = ? FOR UPDATE",
      [order.id]
    );

    const lockedOrder = lockedRows[0];
    if (!lockedOrder) {
      throw new Error("Order not found during lock");
    }

    linkedTradeOrderId = lockedOrder.trade_order_id ?? null;

    // Idempotency for the credit leg: if the order is already completed AND
    // has a credit_transaction_id, the USDX credit has already been applied;
    // skip the update + credit branch to avoid double-crediting.
    //
    // NOTE: this does NOT skip the post-commit triggers below. The linked
    // trade order trigger is itself idempotent (status-transition check), and
    // the stable top-up swap is gated by `target_swap_transaction_id` so a
    // prior crash between credit and swap is recoverable on the next webhook.
    const creditAlreadyApplied =
      lockedOrder.status === "completed" &&
      !!lockedOrder.credit_transaction_id;

    if (creditAlreadyApplied) {
      console.log(
        `[Transak Webhook] Order ${transakOrderId} already credited (tx ${lockedOrder.credit_transaction_id}), skipping update + credit`
      );
    } else {
      await connection.execute(
        `UPDATE onramp_orders SET
          transak_order_id = ?,
          crypto_amount = ?,
          transak_status = ?,
          treasury_tx_hash = ?,
          webhook_payload = ?,
          status = ?,
          failure_reason = ?,
          updated_at = NOW()
         WHERE id = ?`,
        [
          transakOrderId,
          webhookData.cryptoAmount?.toString() || "0",
          webhookData.status,
          webhookData.transactionHash || null,
          JSON.stringify(webhookData),
          newStatus,
          webhookData.statusReason || null,
          order.id,
        ]
      );

      // If completed with a real crypto amount, credit USDX on the SAME connection.
      // The idempotency_key (`transak:<orderId>:credit`) guarantees the credit can
      // never be applied twice even if the webhook is replayed or another code path
      // reaches this branch for the same order.
      if (webhookData.status === "COMPLETED" && webhookData.cryptoAmount > 0) {
        const tusdAmount = webhookData.cryptoAmount.toString();

        const creditResult = await creditBalanceWithConnection(
          connection,
          lockedOrder.user_id,
          "USDX",
          tusdAmount,
          {
            txHash: webhookData.transactionHash,
            notes: `On-ramp via Transak: ${webhookData.fiatAmount} ${webhookData.fiatCurrency} → ${tusdAmount} USDX`,
            createdBy: "transak-webhook",
            idempotencyKey: `transak:${transakOrderId}:credit`,
          }
        );

        await connection.execute(
          `UPDATE onramp_orders SET
            tusd_amount = ?,
            credit_transaction_id = ?,
            completed_at = COALESCE(completed_at, NOW())
           WHERE id = ?`,
          [tusdAmount, creditResult.transactionId, order.id]
        );

        console.log(
          `[Transak Webhook] ${creditResult.alreadyApplied ? "Re-used existing" : "Credited"} ${tusdAmount} USDX to user ${lockedOrder.user_id} (tx ${creditResult.transactionId})`
        );
      }
    }

    // Decide whether the post-commit stable-top-up swap needs to run.
    // We use `lockedOrder.tusd_amount` for the already-credited path so that
    // a prior crash between credit and swap can still be recovered. For the
    // fresh-credit path we use the webhook's cryptoAmount (same value as what
    // we just persisted). Either way the swap is gated by
    // `target_swap_transaction_id` so duplicate webhook deliveries are safe.
    const effectiveTusdAmount = creditAlreadyApplied
      ? lockedOrder.tusd_amount
      : webhookData.status === "COMPLETED" && webhookData.cryptoAmount > 0
      ? webhookData.cryptoAmount.toString()
      : null;

    if (
      effectiveTusdAmount &&
      parseFloat(effectiveTusdAmount) > 0 &&
      lockedOrder.target_token &&
      lockedOrder.target_token !== "USDX" &&
      !lockedOrder.target_swap_transaction_id
    ) {
      stableTopUpUserId = lockedOrder.user_id;
      stableTopUpTarget = lockedOrder.target_token;
      stableTopUpAmount = effectiveTusdAmount;
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    console.error("[Transak Webhook] Error processing:", error);
    throw error;
  } finally {
    connection.release();
  }

  // After committing: trigger linked trade order outside the DB transaction
  // (confirmPayment performs on-chain operations). confirmPayment is itself
  // idempotent against re-entry via its status-transition check.
  if (webhookData.status === "COMPLETED" && linkedTradeOrderId) {
    await triggerLinkedTradeOrder(linkedTradeOrderId, transakOrderId);
  }

  // After committing: if the user picked a non-USD destination on a standalone
  // top-up, convert the credited USDX into the chosen PLAT-fiat via the internal
  // ledger swap. Runs with `skipProcessingFee` because the user already paid
  // the Transak fee on the fiat → USDX leg; we treat both legs as one
  // combined top-up. Failure here leaves the user with USDX (recoverable
  // either via Convert or a future webhook retry — the swap is gated by
  // `target_swap_transaction_id`).
  if (stableTopUpUserId && stableTopUpTarget && stableTopUpAmount) {
    try {
      const swapResult = await executeSwap(
        stableTopUpUserId,
        "USDX",
        stableTopUpTarget,
        stableTopUpAmount,
        {
          notes: `On-ramp target swap for Transak order ${transakOrderId}`,
          skipProcessingFee: true,
        }
      );

      await db.execute(
        `UPDATE onramp_orders SET
          target_swap_transaction_id = ?,
          updated_at = NOW()
         WHERE id = ?`,
        [swapResult.transactionId, order.id]
      );

      console.log(
        `[Transak Webhook] Swapped ${stableTopUpAmount} USDX → ${stableTopUpTarget} for user ${stableTopUpUserId} (tx ${swapResult.transactionId})`
      );
    } catch (swapError) {
      console.error(
        `[Transak Webhook] Target swap to ${stableTopUpTarget} failed for order ${transakOrderId}:`,
        swapError
      );
      // Intentionally do not rethrow — the credit is final, the user has
      // USDX, and the next webhook redelivery (or a manual reconcile) can
      // retry the swap.
    }
  }

  return {
    success: true,
    message: `Order ${transakOrderId} updated to ${newStatus}`,
  };
}

async function triggerLinkedTradeOrder(
  tradeOrderId: string,
  transakOrderId: string
): Promise<void> {
  console.log(
    `[Transak Webhook] Linked trade order ${tradeOrderId} — triggering confirmPayment`
  );
  try {
    const tradeResult = await confirmPayment(tradeOrderId, transakOrderId);
    console.log(
      `[Transak Webhook] Trade order ${tradeOrderId} processed: ${tradeResult.status}`
    );
  } catch (tradeError) {
    console.error(
      `[Transak Webhook] Failed to process linked trade order ${tradeOrderId}:`,
      tradeError
    );
  }
}

// ============================================================================
// TRANSAK PRICE QUOTES (fee estimation)
// ============================================================================

const TRANSAK_PUBLIC_API = isProduction
  ? "https://api.transak.com/api/v1"
  : "https://api-stg.transak.com/api/v1";

export interface TransakFeeItem {
  name: string;
  value: number;
  id: string;
}

export interface TransakPriceQuote {
  fiatAmount: number;
  cryptoAmount: number;
  totalFee: number;
  feeDecimal: number;
  feeBreakdown: TransakFeeItem[];
  fiatCurrency: string;
  cryptoCurrency: string;
}

/**
 * Call Transak's public pricing API to get the net crypto amount and fee
 * breakdown for a given fiat purchase. This lets us show the user exactly
 * how much USDC they'll receive after Transak's processing/network fees.
 */
export async function getTransakPriceQuote(
  fiatCurrency: string,
  fiatAmount: number,
  paymentMethod = "credit_debit_card"
): Promise<TransakPriceQuote> {
  const params = new URLSearchParams({
    partnerApiKey: TRANSAK_CONFIG.apiKey,
    fiatCurrency,
    cryptoCurrency: "USDC",
    isBuyOrSell: "BUY",
    network: TRANSAK_CONFIG.network,
    paymentMethod,
    fiatAmount: fiatAmount.toString(),
  });

  const res = await fetch(`${TRANSAK_PUBLIC_API}/pricing/public/quotes?${params}`);

  if (!res.ok) {
    const body = await res.text();
    console.error("[Transak Price] Quote fetch failed:", res.status, body);
    throw new Error(`Transak price quote failed: ${res.status}`);
  }

  const json = await res.json();
  const data = json.response;

  return {
    fiatAmount: data.fiatAmount,
    cryptoAmount: data.cryptoAmount,
    totalFee: data.totalFee ?? 0,
    feeDecimal: data.feeDecimal ?? 0,
    feeBreakdown: (data.feeBreakdown ?? []).map((f: Record<string, unknown>) => ({
      name: f.name as string,
      value: f.value as number,
      id: f.id as string,
    })),
    fiatCurrency: data.fiatCurrency,
    cryptoCurrency: data.cryptoCurrency,
  };
}

/**
 * Call Transak's public pricing API for a SELL (off-ramp) quote.
 * For SELL, `cryptoAmount` is required and `fiatAmount` is ignored.
 * Returns the fiat the user would receive, total fees, and a fee breakdown.
 */
export async function getTransakSellQuote(
  fiatCurrency: string,
  cryptoAmount: number,
  paymentMethod?: string
): Promise<TransakPriceQuote> {
  const params = new URLSearchParams({
    partnerApiKey: TRANSAK_CONFIG.apiKey,
    fiatCurrency,
    cryptoCurrency: "USDC",
    isBuyOrSell: "SELL",
    network: TRANSAK_CONFIG.network,
    cryptoAmount: cryptoAmount.toString(),
  });
  if (paymentMethod) {
    params.set("paymentMethod", paymentMethod);
  }

  const res = await fetch(`${TRANSAK_PUBLIC_API}/pricing/public/quotes?${params}`);

  if (!res.ok) {
    const body = await res.text();
    console.error("[Transak Price] SELL quote fetch failed:", res.status, body);
    throw new Error(`Transak SELL price quote failed: ${res.status}`);
  }

  const json = await res.json();
  const data = json.response;

  return {
    fiatAmount: data.fiatAmount,
    cryptoAmount: data.cryptoAmount,
    totalFee: data.totalFee ?? 0,
    feeDecimal: data.feeDecimal ?? 0,
    feeBreakdown: (data.feeBreakdown ?? []).map((f: Record<string, unknown>) => ({
      name: f.name as string,
      value: f.value as number,
      id: f.id as string,
    })),
    fiatCurrency: data.fiatCurrency,
    cryptoCurrency: data.cryptoCurrency,
  };
}

// ============================================================================
// ORDER STATUS POLLING (for local dev where webhooks can't reach localhost)
// ============================================================================

const TRANSAK_PARTNER_API = isProduction
  ? "https://api.transak.com/partners/api/v2"
  : "https://api-stg.transak.com/partners/api/v2";

export interface TransakOrderData {
  _id: string;
  status: string;
  fiatCurrency: string;
  fiatAmount: number;
  cryptoCurrency: string;
  cryptoAmount: number;
  network: string;
  walletAddress: string;
  transactionHash?: string;
  partnerOrderId?: string;
  completedAt?: string;
  createdAt: string;
}

/**
 * Fetch order details from Transak's Partner API by Transak order ID.
 */
export async function fetchTransakOrder(
  transakOrderId: string
): Promise<TransakOrderData> {
  const accessToken = await getAccessToken();

  const res = await fetch(`${TRANSAK_PARTNER_API}/order/${transakOrderId}`, {
    method: "GET",
    headers: { "access-token": accessToken },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[Transak API] Failed to fetch order:", res.status, body);
    throw new Error(`Transak order fetch failed: ${res.status}`);
  }

  const json = await res.json();
  return json.data as TransakOrderData;
}

/** Off-ramp (SELL) order lookup — same Partner API endpoint as on-ramp. */
export const fetchTransakSellOrder = fetchTransakOrder;

/**
 * Fetch order from Transak's Partner API by our partnerOrderId.
 * Returns the first matching order, or null if none found.
 * This is needed on localhost where the webhook never fires, so our DB
 * has no transak_order_id — but we DO have the partnerOrderId we sent.
 */
export async function fetchTransakOrderByPartnerOrderId(
  partnerOrderId: string
): Promise<TransakOrderData | null> {
  const accessToken = await getAccessToken();

  const url = `${TRANSAK_PARTNER_API}/orders?filter[partnerOrderId]=${encodeURIComponent(partnerOrderId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "access-token": accessToken },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[Transak API] Failed to fetch by partnerOrderId:", res.status, body);
    return null;
  }

  const json = await res.json();
  const orders = json.data as TransakOrderData[];
  return orders?.[0] ?? null;
}

/**
 * Poll a Transak order and, if COMPLETED, run the same credit flow
 * that the webhook would have triggered.  Designed for local dev
 * where Transak webhooks can't reach localhost.
 */
export async function pollAndProcessTransakOrder(
  transakOrderId: string
): Promise<{ status: string; credited: boolean; message: string }> {
  const order = await fetchTransakOrder(transakOrderId);
  console.log(`[Transak Poll] Order ${transakOrderId} status: ${order.status}`);

  if (order.status !== "COMPLETED") {
    return {
      status: order.status,
      credited: false,
      message: `Order is ${order.status}, not yet completed`,
    };
  }

  // Build a synthetic webhook payload and run through the normal flow
  const syntheticPayload: TransakWebhookPayload = {
    eventID: `poll-${Date.now()}`,
    webhookData: {
      id: transakOrderId,
      status: "COMPLETED",
      partnerOrderId: order.partnerOrderId,
      fiatCurrency: order.fiatCurrency,
      fiatAmount: order.fiatAmount,
      cryptoCurrency: order.cryptoCurrency,
      cryptoAmount: order.cryptoAmount,
      network: order.network,
      walletAddress: order.walletAddress,
      transactionHash: order.transactionHash || "",
      createdAt: order.createdAt,
      updatedAt: order.completedAt || order.createdAt,
    },
  };

  const result = await processTransakWebhook(syntheticPayload);

  return {
    status: order.status,
    credited: result.success,
    message: result.message,
  };
}

// ============================================================================
// SESSION-BASED WIDGET URL (required by Transak API migration)
// ============================================================================
// Transak deprecated direct query-parameter URLs. Widget URLs must now be
// generated server-side via their Create Widget URL API, which returns a
// single-use sessionId URL valid for 5 minutes.

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/**
 * Get (or refresh) the partner access token. Cached for its 7-day lifetime.
 */
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60) {
    return cachedAccessToken.token;
  }

  if (!TRANSAK_CONFIG.apiSecret) {
    throw new Error("TRANSAK_API_SECRET is not configured");
  }

  const res = await fetch(TRANSAK_CONFIG.refreshTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-secret": TRANSAK_CONFIG.apiSecret,
    },
    body: JSON.stringify({ apiKey: TRANSAK_CONFIG.apiKey }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[Transak] Failed to refresh access token:", res.status, body);
    throw new Error(`Transak access token refresh failed: ${res.status}`);
  }

  const json = await res.json();
  const { accessToken, expiresAt } = json.data;

  cachedAccessToken = { token: accessToken, expiresAt };
  console.log("[Transak] Access token refreshed, expires at", new Date(expiresAt * 1000).toISOString());

  return accessToken;
}

/**
 * Generate a session-based widget URL via Transak's Create Widget URL API.
 * Must be called from the backend (server action / API route).
 * Returns a URL valid for 5 minutes with a single-use sessionId.
 */
export async function createWidgetSession(
  widgetParams: Record<string, unknown>
): Promise<string> {
  const accessToken = await getAccessToken();

  const params: Record<string, unknown> = {
    apiKey: TRANSAK_CONFIG.apiKey,
    referrerDomain: TRANSAK_CONFIG.referrerDomain,
    ...widgetParams,
  };

  console.log("[Transak] Creating widget session with params:", JSON.stringify(params, null, 2));
  console.log("[Transak] Session URL:", TRANSAK_CONFIG.sessionUrl);

  const res = await fetch(TRANSAK_CONFIG.sessionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "access-token": accessToken,
    },
    body: JSON.stringify({ widgetParams: params }),
  });

  const rawBody = await res.text();

  if (!res.ok) {
    console.error("[Transak] Failed to create widget session:", res.status, rawBody);
    throw new Error(`Transak widget session creation failed: ${res.status}`);
  }

  const json = JSON.parse(rawBody);
  const widgetUrl = json.data?.widgetUrl as string;

  console.log("[Transak] Session API full response:", rawBody.slice(0, 500));
  console.log("[Transak] Widget URL generated:", widgetUrl);

  if (!widgetUrl) {
    console.error("[Transak] No widgetUrl in response:", rawBody);
    throw new Error("Transak session response missing widgetUrl");
  }

  return widgetUrl;
}

/**
 * Generate a Transak widget URL for the trade buy flow (embedded iframe).
 */
export async function createTradeWidgetUrl(options: {
  partnerOrderId: string;
  partnerCustomerId: string;
  fiatCurrency: string;
  fiatAmount: number;
  email?: string;
  userData?: TransakUserData;
}): Promise<string> {
  const widgetParams: Record<string, unknown> = {
    productsAvailed: "BUY",
    walletAddress: TRANSAK_CONFIG.treasuryWallet,
    network: TRANSAK_CONFIG.network,
    cryptoCurrencyCode: "USDC",
    fiatCurrency: options.fiatCurrency,
    defaultFiatAmount: options.fiatAmount,
    partnerOrderId: options.partnerOrderId,
    partnerCustomerId: String(options.partnerCustomerId),
    disableWalletAddressForm: true,
    themeColor: "10b981",
  };

  if (options.email) {
    widgetParams.email = options.email;
    widgetParams.isAutoFillUserData = true;
  }

  if (options.userData) {
    widgetParams.userData = options.userData;
    widgetParams.isAutoFillUserData = true;
  }

  return createWidgetSession(widgetParams);
}

/**
 * Generate a Transak widget URL for the standalone on-ramp flow (redirect).
 */
export async function createOnRampWidgetUrl(options: {
  partnerOrderId: string;
  userId: string;
  fiatCurrency: string;
  fiatAmount: number;
  email?: string;
  userData?: TransakUserData;
}): Promise<string> {
  const widgetParams: Record<string, unknown> = {
    walletAddress: TRANSAK_CONFIG.treasuryWallet,
    network: TRANSAK_CONFIG.network,
    partnerOrderId: options.partnerOrderId,
    partnerCustomerId: options.userId,
    cryptoCurrencyCode: "USDC",
    fiatCurrency: options.fiatCurrency,
    defaultFiatAmount: options.fiatAmount,
    disableWalletAddressForm: true,
    hideMenu: true,
    themeColor: "10b981",
    // No `redirectURL` here: we want Transak's native "Crypto is on the way"
    // success screen (same as the PLAT Buy flow). The dApp tab the user
    // launched the widget from is already polling the order status and will
    // surface the completion toast, so there's nothing to do on the Transak
    // side post-payment beyond closing the popup.
  };

  if (options.email) {
    widgetParams.email = options.email;
    widgetParams.isAutoFillUserData = true;
  }

  if (options.userData) {
    widgetParams.userData = options.userData;
    widgetParams.isAutoFillUserData = true;
  }

  return createWidgetSession(widgetParams);
}

// ============================================================================
// ADMIN FUNCTIONS
// ============================================================================

/**
 * Get all on-ramp orders (admin only)
 */
export async function getAllOnRampOrders(
  status?: OnRampStatus,
  limit: number = 50
): Promise<OnRampOrder[]> {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  
  let query = "SELECT * FROM onramp_orders";
  const params: any[] = [];
  
  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }
  
  query += ` ORDER BY created_at DESC LIMIT ${safeLimit}`;
  
  const [rows] = await adminDb.query<OnRampOrderRow[]>(query, params);
  return rows;
}

/**
 * Manually credit USDX to a user (admin recovery)
 */
export async function manualCreditOnRamp(
  orderId: string,
  adminUserId: string,
  amount: string,
  notes: string
): Promise<{ success: boolean; transactionId?: string }> {
  const [rows] = await adminDb.execute<OnRampOrderRow[]>(
    "SELECT * FROM onramp_orders WHERE order_id = ?",
    [orderId]
  );
  
  const order = rows[0];
  if (!order) {
    throw new Error("Order not found");
  }
  
  if (order.status === "completed") {
    throw new Error("Order already completed");
  }
  
  const creditResult = await creditBalance(
    order.user_id,
    "USDX",
    amount,
    {
      notes: `Manual credit by admin: ${notes}`,
      createdBy: adminUserId,
    }
  );
  
  await adminDb.execute(
    `UPDATE onramp_orders SET
      tusd_amount = ?,
      credit_transaction_id = ?,
      status = 'completed',
      completed_at = NOW(),
      failure_reason = ?
     WHERE order_id = ?`,
    [amount, creditResult.transactionId, `Manual: ${notes}`, orderId]
  );
  
  return { success: true, transactionId: creditResult.transactionId };
}

