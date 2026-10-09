# Operations runbook — Ledger consistency & DB outages

This runbook covers the failure modes addressed by the Ledger Consistency
Hardening plan: Azure MySQL outages, stuck orders, chain-vs-ledger drift,
and replaying dropped Transak events. Keep it near your on-call tooling.

---

## 1. Quick links

| Action                              | Where                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| DB health probe                     | `GET /api/health/db`                                       |
| Scheduled reconciler                | `GET /api/cron/reconcile` (auth: `Bearer $CRON_SECRET`)    |
| Manual Transak order poll (admin)   | `POST /api/admin/transak-poll?orderId=<transakOrderId>`    |
| Transak webhook endpoint            | `POST /api/webhooks/transak`                               |
| Idempotency migration               | [`sql/add_idempotency_keys.sql`](../sql/add_idempotency_keys.sql) |

---

## 2. When MySQL goes down (Azure maintenance / network partition)

### 2.1 What the app does automatically

1. The Transak webhook route now returns **HTTP 503** when it cannot
   durably record an event. Transak's retry policy will re-deliver the
   webhook until it is accepted. No event is silently dropped.
2. `withMysqlRetry` (see [`app/lib/db.ts`](../app/lib/db.ts)) retries
   transient errors (`ECONNRESET`, `PROTOCOL_CONNECTION_LOST`, pool
   timeouts, deadlocks) with exponential backoff.
3. A simple circuit breaker trips after 5 consecutive transient failures
   and stays open for 15 seconds so upstream callers fail fast instead
   of piling up threads.
4. Ledger primitives (`creditBalance`, `debitBalance`) reject duplicate
   applications via a UNIQUE index on
   `ledger_transactions.idempotency_key`.

### 2.2 While the DB is down

- Leave Transak webhooks enabled; they will retry against the 503.
- Put the UI into maintenance mode. Poll `/api/health/db`:

  ```bash
  curl -fsS https://<host>/api/health/db || echo "DB unhealthy"
  ```

  Returns HTTP 503 + `{ ok: false }` when unhealthy — wire this into the
  global banner / status page. The circuit breaker state is exposed as
  `circuitOpen`.

- Do NOT attempt to manually replay webhooks until MySQL is back;
  nothing can persist.

### 2.3 After the DB recovers

Run the reconciler (or wait for the scheduled cron):

```bash
curl -fsS \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://<host>/api/cron/reconcile?lookbackHours=72&maxOrders=200"
```

Expected output shape:

```json
{
  "ok": true,
  "elapsedMs": 1234,
  "onramp":   { "scanned": 17, "resolved": 6, "failures": [] },
  "cashout":  { "users": 5,  "reconciled": 2, "failures": [] },
  "trades":   { "scanned": 3, "completed": 2, "needsReview": [], "failures": [] }
}
```

The `trades` sweep targets `trade_orders` stuck in `executing` older than
`stuckMinAgeMinutes` (default 10). When a row has `operator_tx_hash` but no
`credit_transaction_id`, the reconciler finishes the ledger credit via the
idempotency key `trade:<orderId>:credit`. Rows with no `operator_tx_hash`
are surfaced in `needsReview` instead of auto-resolved — the on-chain
state is unknown and an operator must verify the wallet's tx history
before deciding whether to retry or refund.

Then audit the tables below (Section 4).

---

## 3. Transak retry & replay

- Transak re-delivers on HTTP 4xx/5xx. A 503 from our webhook therefore
  counts as a valid re-delivery trigger; we rely on this during outages.
- Duplicate deliveries are safe because:
  - `processTransakWebhook` is a single DB transaction (on-ramp row
    update + USDX credit commit together).
  - The credit uses idempotency key `transak:<transakOrderId>:credit`
    enforced by the UNIQUE index, so even if two workers race, only one
    credit row can exist.
  - `confirmPayment` transitions the trade order atomically
    (`pending_payment → payment_received`) and the deferred debit/credit
    use `trade:<orderId>:...` idempotency keys.
- If Transak exhausts its retries without success, manually poll the
  order through the admin endpoint:

  ```bash
  curl -fsS -X POST "https://<host>/api/admin/transak-poll?orderId=<transakOrderId>" \
    -H "Authorization: Bearer $CRON_SECRET"
  ```

  This endpoint is gated by `CRON_SECRET` (same shared secret as `/api/cron/*`)
  and fails closed if that env var is unset. It does NOT accept the checkout
  API key.

---

## 4. Standard audit queries

Run as a read-only admin. These work against the current schema
(trade_orders / onramp_orders / cashout_orders / ledger_transactions).

### 4.1 Orders stuck in intermediate states

```sql
-- Trade orders not finalized within 15 minutes
SELECT order_id, user_id, status, created_at, payment_provider,
       operator_tx_hash, credit_transaction_id
FROM trade_orders
WHERE status IN ('pending_payment', 'payment_received', 'executing')
  AND created_at < NOW() - INTERVAL 15 MINUTE
ORDER BY created_at ASC;
```

```sql
-- On-ramp orders not completed within 15 minutes
SELECT order_id, user_id, status, transak_order_id, partner_order_id, created_at
FROM onramp_orders
WHERE status IN ('pending', 'processing')
  AND created_at < NOW() - INTERVAL 15 MINUTE
ORDER BY created_at ASC;
```

```sql
-- Cashouts stuck awaiting Transak
SELECT cashout_id, user_id, status, transak_order_id, operator_tx_hash, created_at
FROM cashout_orders
WHERE status IN ('awaiting_transak', 'crypto_sent', 'processing')
  AND created_at < NOW() - INTERVAL 30 MINUTE
ORDER BY created_at ASC;
```

### 4.2 Chain vs ledger divergence (trade orders)

```sql
-- On-chain tx recorded but no ledger credit committed
SELECT order_id, user_id, status, operator_tx_hash, credit_transaction_id,
       tusd_amount, tglobal_amount, updated_at
FROM trade_orders
WHERE operator_tx_hash IS NOT NULL
  AND credit_transaction_id IS NULL
  AND status NOT IN ('failed', 'cancelled', 'slippage_fallback', 'price_changed')
  AND updated_at < NOW() - INTERVAL 10 MINUTE
ORDER BY updated_at ASC;
```

Resolution: run the reconciler. If it does not clear, the on-chain tx
needs manual review (did it revert? did the credit race a failure
refund?). Credit reconciliation can be performed via `creditBalance`
with a stable `idempotencyKey` of `trade:<orderId>:credit` — the unique
constraint prevents double-crediting.

### 4.3 Transak webhook failures

```sql
-- Recent webhook failures (last 24h)
SELECT id, event_id, transak_order_id, process_result, error_message, created_at
FROM onramp_webhook_logs
WHERE (processed = 0 OR error_message IS NOT NULL)
  AND created_at >= NOW() - INTERVAL 24 HOUR
ORDER BY created_at DESC;
```

The raw payload is stored in `raw_payload`. You can replay a specific
event by POSTing it back to `/api/admin/transak-poll` (preferred) or by
calling `processTransakWebhook` from a server shell.

### 4.4 Duplicate credit attempts (should be zero)

```sql
-- If >0 rows come back here something bypassed idempotency
SELECT idempotency_key, COUNT(*) AS dup
FROM ledger_transactions
WHERE idempotency_key IS NOT NULL
GROUP BY idempotency_key
HAVING dup > 1;
```

---

## 5. Recovery playbook — after an outage

1. Confirm `/api/health/db` returns `{ ok: true }` and the circuit is
   closed (`circuitOpen: false`).
2. Kick off the reconciler:

   ```bash
   curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
     "https://<host>/api/cron/reconcile?lookbackHours=72"
   ```

3. Run the four audit queries in Section 4. Expect the "stuck orders"
   lists to shrink on each reconciler pass. If any row sits stuck for
   multiple passes, inspect it manually:

   - `trade_orders.operator_tx_hash` — on-chain? verify receipt.
   - `onramp_orders.transak_order_id` — hit `/api/admin/transak-poll`.
   - `cashout_orders.transak_order_id` — hit
     `syncCashoutStatusFromTransak` (`/cashout` page action) or call
     `reconcileStaleAwaitingOrders` via a server action.

4. Clear the maintenance banner only once the audit queries return
   empty / near-empty and the webhook log shows recent successes.

---

## 6. Cron wiring (Azure / Vercel / GitHub Actions)

All of these just need to call the reconciler endpoint every ~5 minutes
with the shared secret.

**Vercel Cron** (`vercel.json`):

```json
{
  "crons": [
    { "path": "/api/cron/reconcile", "schedule": "*/5 * * * *" }
  ]
}
```

Set `CRON_SECRET` in the Vercel project and include it on the request:
either via `x-cron-secret` (paired with Vercel's own `x-vercel-cron`
header), or by scheduling an external pinger with
`Authorization: Bearer <secret>`.

**Azure Function (timer trigger)** — use a `TimerTrigger` function
that curls the endpoint with the `Authorization: Bearer` header.

**GitHub Actions** (fallback):

```yaml
on:
  schedule:
    - cron: "*/5 * * * *"
jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://<host>/api/cron/reconcile
```

---

## 7. Env vars relevant to this playbook

| Variable             | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `MYSQL_HOST/USER/PASSWORD/DATABASE` | Azure Database for MySQL connection.             |
| `MYSQL_PORT`         | Defaults to 3306; set when Azure uses a non-default port.       |
| `MYSQL_SSL`          | `disabled` to turn off TLS (do not do this in prod).            |
| `MYSQL_SSL_CA`       | PEM contents of the Azure CA for strict verification.           |
| `CRON_SECRET`        | Shared secret for `/api/cron/reconcile`.                        |
| `TRANSAK_*`          | Transak API credentials; see `app/lib/transak-service.ts`.      |

---

## 8. Explicit non-goals

- Serving writes while MySQL is fully offline. The goal is **no lost
  events, no duplicates** — not "no downtime".
- Two-phase commit between MySQL, Transak, and the blockchain. We rely
  on idempotent retries and post-hoc reconciliation instead.
