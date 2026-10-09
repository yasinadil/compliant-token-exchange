// app/api/webhooks/pimlico-sponsor/route.ts
// Pimlico sponsorship-policy webhook.
//
// Pimlico calls this endpoint on every pm_sponsorUserOperation request that
// matches the policy this URL is attached to (and again when a sponsorship
// is finalized on-chain). We verify the svix-signed payload with the official
// @pimlico/webhook verifier, then decide whether the UserOperation should be
// sponsored based on a strict allowlist of smart-account addresses (typically
// just the operator's).
//
// Response contract (per Pimlico docs):
//   requested  -> { "sponsor": true }
//                 { "sponsor": false }
//   finalized  -> 200 OK (no body required; informational only)
//
// Failure policy: we fail CLOSED. Missing config, bad signature, parse errors
// or any unexpected exception all return `sponsor: false` for the requested
// event. This prevents accidental sponsorship exposure while the endpoint is
// being set up or under any kind of fault.
//
// Config (both required):
//   PIMLICO_WEBHOOK_SECRET           — signing secret from the Pimlico dashboard
//                                      (looks like "pim_whsec_..."; passed
//                                      verbatim to pimlicoWebhookVerifier).
//   PIMLICO_SPONSOR_ALLOWED_SENDERS  — comma-separated list of smart-account
//                                      addresses allowed to be sponsored
//                                      (NOT EOA private keys / addresses).

import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { pimlicoWebhookVerifier } from "@pimlico/webhook";

const WEBHOOK_SECRET = process.env.PIMLICO_WEBHOOK_SECRET;
const RAW_ALLOWLIST = process.env.PIMLICO_SPONSOR_ALLOWED_SENDERS || "";

const ALLOWLIST: Set<Address> = new Set(
  RAW_ALLOWLIST.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => {
      if (!isAddress(s)) {
        console.warn(
          `[Pimlico Webhook] Ignoring malformed address in PIMLICO_SPONSOR_ALLOWED_SENDERS: ${s}`
        );
        return false;
      }
      return true;
    })
    .map((s) => getAddress(s))
);

const verifier = WEBHOOK_SECRET
  ? pimlicoWebhookVerifier(WEBHOOK_SECRET)
  : null;

function deny(reason: string) {
  console.warn(`[Pimlico Webhook] DENY: ${reason}`);
  return NextResponse.json({ sponsor: false }, { status: 200 });
}

function approve(sender: Address) {
  console.log(`[Pimlico Webhook] APPROVE sender=${sender}`);
  return NextResponse.json({ sponsor: true }, { status: 200 });
}

function ack() {
  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function POST(request: NextRequest) {
  if (!WEBHOOK_SECRET || !verifier) {
    console.error(
      "[Pimlico Webhook] PIMLICO_WEBHOOK_SECRET is not set — failing closed."
    );
    return deny("Webhook secret not configured");
  }

  if (ALLOWLIST.size === 0) {
    console.error(
      "[Pimlico Webhook] PIMLICO_SPONSOR_ALLOWED_SENDERS is empty — failing closed."
    );
    return deny("Allowlist not configured");
  }

  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error("[Pimlico Webhook] Failed to read body:", err);
    return deny("Unreadable body");
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let event;
  try {
    event = verifier(headers, rawBody);
  } catch (err) {
    console.error(
      "[Pimlico Webhook] Signature verification failed:",
      err instanceof Error ? err.message : err
    );
    return deny("Invalid or missing signature");
  }

  if (event.type === "user_operation.sponsorship.finalized") {
    console.log(
      `[Pimlico Webhook] finalized sender=${event.data?.object?.userOperation?.sender ?? "?"}`
    );
    return ack();
  }

  if (event.type !== "user_operation.sponsorship.requested") {
    console.warn(`[Pimlico Webhook] Unknown event type: ${event.type}`);
    return deny(`Unknown event type: ${event.type}`);
  }

  const senderRaw = event.data?.object?.userOperation?.sender;
  if (!senderRaw || typeof senderRaw !== "string" || !isAddress(senderRaw)) {
    return deny("Missing or malformed userOperation.sender");
  }

  let normalized: Address;
  try {
    normalized = getAddress(senderRaw);
  } catch {
    return deny("Malformed sender address");
  }

  if (!ALLOWLIST.has(normalized)) {
    return deny(`Sender ${normalized} not on allowlist`);
  }

  return approve(normalized);
}

// Pimlico (and reviewers) may hit the URL via GET to confirm reachability.
// Returns whether the webhook is usably configured — does NOT leak addresses.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "exchange-pimlico-sponsor-webhook",
    secretConfigured: Boolean(WEBHOOK_SECRET),
    allowlistSize: ALLOWLIST.size,
    timestamp: new Date().toISOString(),
  });
}
