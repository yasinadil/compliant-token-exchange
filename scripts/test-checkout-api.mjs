// scripts/test-checkout-api.mjs
// End-to-end smoke test for the Checkout API (4 endpoints):
//   POST /api/checkout/charges         (create charge)
//   GET  /api/checkout/charges/:id     (get one charge)
//   GET  /api/checkout/charges         (list charges)
//   POST /api/checkout/refunds         (full/partial refund)
//   GET  /api/checkout/balance         (available balance)
//
// It exercises the happy path AND the guarantees added in the atomicity fix:
//   - charge idempotency replay returns the SAME charge (no double debit)
//   - refund idempotency replay returns the SAME refund (no double credit)
//   - over-refund is rejected
//   - balance nets back to the starting value (money conserved)
//   - negative cases: bad secret (401), missing idempotency_key (400),
//     unsupported currency (400)
//
// Nothing is imported from the app — it only makes HTTP calls, so you can run
// it against local dev, the VM, or prod (careful: it moves real balance, though
// it fully refunds back to net zero).
//
// Usage (PowerShell):
//   $env:CHECKOUT_BASE_URL="http://127.0.0.1:3000"
//   $env:CHECKOUT_API_KEY="exch_key_..."
//   $env:CHECKOUT_API_SECRET="exch_sec_..."
//   $env:CHECKOUT_TEST_USER_ID="3715"
//   node scripts/test-checkout-api.mjs
//
// Optional: $env:CHECKOUT_AMOUNT="1.00"  (default), currency is PLAT only.

const BASE_URL = (process.env.CHECKOUT_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const API_KEY = process.env.CHECKOUT_API_KEY || "";
const API_SECRET = process.env.CHECKOUT_API_SECRET || "";
const USER_ID = process.env.CHECKOUT_TEST_USER_ID || "";
const CURRENCY = "PLAT";
const AMOUNT = process.env.CHECKOUT_AMOUNT || "1.00";

if (!API_KEY || !API_SECRET || !USER_ID) {
  console.error(
    "Missing config. Set CHECKOUT_API_KEY, CHECKOUT_API_SECRET, CHECKOUT_TEST_USER_ID " +
      "(and optionally CHECKOUT_BASE_URL, CHECKOUT_AMOUNT).\n\n" +
      "The test user must hold at least " + AMOUNT + " " + CURRENCY + " for the charge to succeed."
  );
  process.exit(2);
}

const rid = () => Math.random().toString(36).slice(2, 10);

async function req(method, path, { auth = true, body, badSecret = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    headers["X-API-Key"] = API_KEY;
    headers["X-API-Secret"] = badSecret ? "exch_sec_wrong" : API_SECRET;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const num = (s) => parseFloat(s ?? "0");
const approx = (a, b) => Math.abs(a - b) < 1e-9;

async function main() {
  console.log(`Checkout API test → ${BASE_URL}`);
  console.log(`user_id=${USER_ID} currency=${CURRENCY} amount=${AMOUNT}\n`);

  // --- 1. Starting balance -------------------------------------------------
  console.log("1) GET /balance (starting)");
  const start = await req("GET", `/api/checkout/balance?user_id=${encodeURIComponent(USER_ID)}&currency=${CURRENCY}`);
  check("balance returns 200", start.status === 200, start.json);
  check("balance has 'available'", typeof start.json?.available === "string", start.json);
  const startBal = num(start.json?.available);
  console.log(`     starting available = ${startBal}`);
  if (startBal < num(AMOUNT)) {
    console.log(`\n  ! Test user has less than ${AMOUNT} ${CURRENCY}. Fund it or lower CHECKOUT_AMOUNT.\n`);
  }

  // --- 2. Create charge ----------------------------------------------------
  console.log("\n2) POST /charges (create)");
  const chargeKey = `test-charge-${rid()}`;
  const reference = `test-order-${rid()}`;
  const create = await req("POST", "/api/checkout/charges", {
    body: { user_id: USER_ID, amount: AMOUNT, currency: CURRENCY, reference, idempotency_key: chargeKey, description: "smoke test" },
  });
  check("charge returns 200", create.status === 200, create.json);
  const chargeId = create.json?.charge?.id;
  check("charge has id (chg_)", typeof chargeId === "string" && chargeId.startsWith("chg_"), create.json);
  check("charge amount matches", approx(num(create.json?.charge?.amount), num(AMOUNT)), create.json?.charge);

  // Balance dropped by exactly AMOUNT
  const afterCharge = await req("GET", `/api/checkout/balance?user_id=${encodeURIComponent(USER_ID)}&currency=${CURRENCY}`);
  check("balance debited by amount", approx(num(afterCharge.json?.available), startBal - num(AMOUNT)), {
    before: startBal, after: num(afterCharge.json?.available),
  });

  // --- 3. Idempotency replay (THE atomicity fix) ---------------------------
  console.log("\n3) POST /charges (idempotency replay — must NOT double-debit)");
  const replay = await req("POST", "/api/checkout/charges", {
    body: { user_id: USER_ID, amount: AMOUNT, currency: CURRENCY, reference, idempotency_key: chargeKey, description: "smoke test" },
  });
  check("replay returns 200", replay.status === 200, replay.json);
  check("replay returns SAME charge id", replay.json?.charge?.id === chargeId, { first: chargeId, replay: replay.json?.charge?.id });
  const afterReplay = await req("GET", `/api/checkout/balance?user_id=${encodeURIComponent(USER_ID)}&currency=${CURRENCY}`);
  check("balance UNCHANGED after replay (no double debit)", approx(num(afterReplay.json?.available), startBal - num(AMOUNT)), {
    expected: startBal - num(AMOUNT), got: num(afterReplay.json?.available),
  });

  // --- 4. Get one charge ---------------------------------------------------
  console.log("\n4) GET /charges/:id");
  const getOne = await req("GET", `/api/checkout/charges/${chargeId}`);
  check("get charge returns 200", getOne.status === 200, getOne.json);
  check("get charge id matches", getOne.json?.charge?.id === chargeId, getOne.json);

  // --- 5. List charges -----------------------------------------------------
  console.log("\n5) GET /charges (list)");
  const list = await req("GET", `/api/checkout/charges?user_id=${encodeURIComponent(USER_ID)}&reference=${encodeURIComponent(reference)}`);
  check("list returns 200", list.status === 200, list.json);
  check("list includes our charge", Array.isArray(list.json?.charges) && list.json.charges.some((c) => c.charge_id === chargeId || c.id === chargeId), list.json);

  // --- 6. Partial refund ---------------------------------------------------
  console.log("\n6) POST /refunds (partial)");
  const partAmt = (num(AMOUNT) * 0.4).toFixed(2);
  const refundKey1 = `test-refund-${rid()}`;
  const partRefund = await req("POST", "/api/checkout/refunds", {
    body: { charge_id: chargeId, amount: partAmt, reason: "partial test", idempotency_key: refundKey1 },
  });
  check("partial refund returns 200", partRefund.status === 200, partRefund.json);
  const refundId = partRefund.json?.refund?.id;
  check("refund has id (ref_)", typeof refundId === "string" && refundId.startsWith("ref_"), partRefund.json);

  // --- 7. Refund idempotency replay ---------------------------------------
  console.log("\n7) POST /refunds (idempotency replay — must NOT double-credit)");
  const refundReplay = await req("POST", "/api/checkout/refunds", {
    body: { charge_id: chargeId, amount: partAmt, reason: "partial test", idempotency_key: refundKey1 },
  });
  check("refund replay returns 200", refundReplay.status === 200, refundReplay.json);
  check("refund replay returns SAME refund id", refundReplay.json?.refund?.id === refundId, { first: refundId, replay: refundReplay.json?.refund?.id });

  // --- 8. Over-refund guard ------------------------------------------------
  console.log("\n8) POST /refunds (over-refund — must be rejected)");
  const over = await req("POST", "/api/checkout/refunds", {
    body: { charge_id: chargeId, amount: (num(AMOUNT) * 5).toFixed(2), idempotency_key: `test-refund-${rid()}` },
  });
  check("over-refund rejected with 400", over.status === 400, over.json);

  // --- 9. Refund remainder (full) -----------------------------------------
  console.log("\n9) POST /refunds (remaining — full)");
  const remainder = (num(AMOUNT) - num(partAmt)).toFixed(2);
  const finalRefund = await req("POST", "/api/checkout/refunds", {
    body: { charge_id: chargeId, amount: remainder, reason: "remainder", idempotency_key: `test-refund-${rid()}` },
  });
  check("remainder refund returns 200", finalRefund.status === 200, finalRefund.json);

  // Balance back to start (money conserved)
  const end = await req("GET", `/api/checkout/balance?user_id=${encodeURIComponent(USER_ID)}&currency=${CURRENCY}`);
  check("balance restored to start (net zero)", approx(num(end.json?.available), startBal), { start: startBal, end: num(end.json?.available) });

  // --- 10. Negative cases --------------------------------------------------
  console.log("\n10) Negative cases");
  const badKey = await req("GET", `/api/checkout/balance?user_id=${encodeURIComponent(USER_ID)}&currency=${CURRENCY}`, { badSecret: true });
  check("bad secret → 401", badKey.status === 401, badKey.json);

  const noIdem = await req("POST", "/api/checkout/charges", {
    body: { user_id: USER_ID, amount: AMOUNT, currency: CURRENCY, reference: `x-${rid()}` },
  });
  check("charge without idempotency_key → 400", noIdem.status === 400, noIdem.json);

  const badCur = await req("POST", "/api/checkout/charges", {
    body: { user_id: USER_ID, amount: AMOUNT, currency: "USD", reference: `x-${rid()}`, idempotency_key: `x-${rid()}` },
  });
  check("unsupported currency → 400", badCur.status === 400, badCur.json);

  // --- Summary -------------------------------------------------------------
  console.log(`\n${"=".repeat(48)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(48)}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nTest run crashed:", err);
  process.exit(1);
});
