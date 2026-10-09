# Exchange dApp — SQL migration bundle

This folder is the authoritative SQL set for the Exchange dApp backend. It targets
**Azure Database for MySQL – Flexible Server** and uses the standard MySQL wire
protocol (driver: `mysql2/promise` in [`app/lib/db.ts`](../app/lib/db.ts)).

> **Greenfield install.** The target database is expected to be
> empty (no Exchange tables, no Exchange data). This bundle is a **one-time initial
> install**, not an incremental upgrade from an earlier revision.

---

## TL;DR — what to apply

Pick **one** of three equivalent options. Each applies the same 18 scripts in
the same order.

| Option | What you run | When to pick it |
|---|---|---|
| **A. Single file** | [`schema_init_greenfield.sql`](./schema_init_greenfield.sql) | Azure Portal query editor, one-shot automation, or anyone who wants zero chance of running files out of order. |
| **B. Numbered folder** | Files `001_…` → `018_…` in [`migrations/`](./migrations/) | CI jobs, MySQL Workbench, anything that can sort by filename. |
| **C. Raw files** | The 18 files in this folder in the exact order of the [migration table](#greenfield-install-18-files-in-order) | Only if you are manually reviewing each file. Easy to mis-order — prefer A or B. |

After applying the 18 scripts, **optionally** apply
[`optional/enum_union_hardening.sql`](./optional/enum_union_hardening.sql) as a
19th step to lock the reorderable enums (see [Ordering rules](#ordering-rules-why-order-is-mandatory)).

Then deploy the Next.js app with the `MYSQL_*` env vars documented in
[§ Connecting the dApp](#connecting-the-dapp-to-azure-database-for-mysql).

---

## Greenfield install: 18 files in order

Apply on an **empty** database. Driver is `mysql2` (TLS supported). All file
links below are relative to this `sql/` folder.

| Step | File | Purpose |
|------|------|---------|
| 1  | [`create_ledger_tables.sql`](./create_ledger_tables.sql) | Core ledger: `internal_balances`, `swap_transactions`, `ledger_transactions`, `supported_tokens` (already seeds PLAT\* tokens and generic oracle column names). |
| 2  | [`add_security_tables.sql`](./add_security_tables.sql) | Swap security tables + `admin_audit_log` (FK needs `swap_transactions`). |
| 3  | [`alter_user_swap_daily_limit_null_default.sql`](./alter_user_swap_daily_limit_null_default.sql) | Tweaks `user_swap_settings.daily_limit_usd`. |
| 4  | [`create_internal_wallets.sql`](./create_internal_wallets.sql) | Smart-account wallet rows. |
| 5  | [`add_smart_account_address.sql`](./add_smart_account_address.sql) | Adds `smart_account_address`. |
| 6  | [`create_swap_platform_settings.sql`](./create_swap_platform_settings.sql) | Platform KV table (required before step 17’s processing-fee insert). |
| 7  | [`create_trade_orders.sql`](./create_trade_orders.sql) | Trade + payment-webhook-log tables. |
| 8  | [`add_balance_buy_columns.sql`](./add_balance_buy_columns.sql) | Balance + Transak split columns (creates `balance_swap_tx_id` used next). |
| 9  | [`add_deferred_trade_statuses.sql`](./add_deferred_trade_statuses.sql) | Extends `trade_orders.status` enum. |
| 10 | [`create_onramp_tables.sql`](./create_onramp_tables.sql) | Transak on-ramp tables. |
| 11 | [`link_trade_onramp.sql`](./link_trade_onramp.sql) | `onramp_order_id` / `trade_order_id` link (**must** run after step 8). |
| 12 | [`create_cashout_orders.sql`](./create_cashout_orders.sql) | Cashout table. |
| 13 | [`alter_cashout_for_transak.sql`](./alter_cashout_for_transak.sql) | Transak off-ramp columns + statuses. |
| 14 | [`create_staking_orders.sql`](./create_staking_orders.sql) | `staking_orders` + **first** extension of `ledger_transactions.type`. |
| 15 | [`create_checkout_tables.sql`](./create_checkout_tables.sql) | Checkout API tables + extends `ledger_transactions.type` + extends `admin_audit_log.action_type`. |
| 16 | [`add_balance_hold.sql`](./add_balance_hold.sql) | **Must run after** steps 14–15: final `ledger_transactions.type` includes `hold` / `hold_release`. |
| 17 | [`add_processing_fee.sql`](./add_processing_fee.sql) | Fee columns, `collected_fees`, seed row; extends `admin_audit_log.action_type` again. |
| 18 | [`add_idempotency_keys.sql`](./add_idempotency_keys.sql) | Adds `idempotency_key` columns + unique indexes on `ledger_transactions`, `trade_orders`, `cashout_orders`. Depends on steps 1, 7, and 12. Touches no enums, safe as last step. **Required**: without this migration, Transak webhook, `createBuyOrder`, and `initiateCashoutWithTransak` inserts fail at runtime. |

### Legacy upgrade script (not part of a fresh install)

| File | Reason |
|------|--------|
| [`add_oracle_source_columns.sql`](./add_oracle_source_columns.sql) | Legacy upgrade only; expects old `chainlink_*` columns. **Errors on a fresh DB** created from `create_ledger_tables.sql`. |


---

## Ordering rules (why order is mandatory)

Several scripts do `ALTER TABLE … MODIFY COLUMN <col> ENUM(…)`, which
**replaces** the full enum list. Running them out of order silently drops
values the app needs.

1. **`ledger_transactions.type`** — steps **14 → 15 → 16** in that exact order.
   - Step 14 adds `stake_lock`, `stake_unlock`, `stake_reward`.
   - Step 15 adds `checkout_debit`, `checkout_refund`.
   - Step 16 adds `hold`, `hold_release`.
   - If 14 or 15 runs **after** 16, the later-added values disappear and code
     that writes them will throw `Data truncated for column 'type'`.

2. **`admin_audit_log.action_type`** — step **15 → step 17** in that order.
   - Step 2 seeds the base list.
   - Step 15 adds `create_checkout_api_key`, `revoke_checkout_api_key`.
   - Step 17 adds `update_swap_setting` (and keeps step 15’s additions).
   - If 15 runs **after** 17, `update_swap_setting` is dropped and
     `platform_settings` audit writes fail.

The [migration table](#greenfield-install-18-files-in-order) already satisfies
both rules. If you use option **A** or **B** above, this is automatic.

### Optional hardening

Apply [`optional/enum_union_hardening.sql`](./optional/enum_union_hardening.sql)
as a 19th step to force both enums to their full union. It is idempotent, so
any future accidental replay of steps 14–17 cannot silently lose values.

---

## Connecting the dApp to Azure Database for MySQL

All of the following is already wired into
[`app/lib/db.ts`](../app/lib/db.ts) — deployers only have to set environment
variables.

### 1. Provision

Create an **Azure Database for MySQL – Flexible Server**. (Single Server is
deprecated as of September 2024 and must not be used.) Inside that server,
create the application database, e.g. `exchange`:

```sql
CREATE DATABASE exchange CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Create at least one application user with least-privilege grants on that
database (recommended: separate **admin/migration user** for DDL and
**runtime user** for the app):

```sql
CREATE USER 'exchange'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON exchange.* TO 'exchange'@'%';
FLUSH PRIVILEGES;
```

### 2. Networking

Pick **one**:

- **Public access + firewall** — enable public access on the server and add the
  app’s outbound IPs (Vercel / Azure App Service egress / CI runner IPs that
  will apply the migrations) to the server firewall. Required when the app
  runs outside Azure.
- **Private access (VNet integration)** — attach the server to a VNet and put
  the app service / container app on the same or peered VNet. Preferred for
  production.

### 3. TLS / SSL (required)

Azure MySQL Flexible Server enforces encrypted connections. [`app/lib/db.ts`](../app/lib/db.ts)
includes a `buildSslOption()` helper that honours two env vars:

1. Download the CA bundle Azure recommends (currently the **DigiCert Global
   Root G2** bundle — see the
   [Microsoft TLS/SSL docs](https://learn.microsoft.com/en-us/azure/mysql/flexible-server/how-to-connect-tls-ssl)).
   Save the file somewhere the runtime can read it (e.g. commit as
   `certs/DigiCertGlobalRootG2.crt.pem`, or mount as a secret file).
2. Set `MYSQL_SSL_CA` to that file path. `db.ts` will pass
   `{ ca, minVersion: 'TLSv1.2', rejectUnauthorized: true }` to `mysql2` —
   strict verification is automatic.
3. If you need **encrypted but unverified** (dev only), set `MYSQL_SSL=true`
   instead. `db.ts` falls back to `{ rejectUnauthorized: false }`. **Do not
   use this in production.**
4. For local dev with a plaintext MySQL, leave both unset.

### 4. Environment variables

| Var | Required? | Notes |
|---|---|---|
| `MYSQL_HOST` | yes | Azure FQDN, e.g. `exchange-prod.mysql.database.azure.com` (no scheme, no `https://`). |
| `MYSQL_PORT` | no | Defaults to `3306`. Flexible Server uses `3306`. |
| `MYSQL_USER` | yes | **Plain username** on Flexible Server (e.g. `exchange`). Do **not** use the legacy `user@servername` format — that was a Single Server requirement and has been deprecated. |
| `MYSQL_PASSWORD` | yes | Password for that user. |
| `MYSQL_DATABASE` | yes | Database created in step 1 (e.g. `exchange`). |
| `MYSQL_SSL_CA` | prod | Path to the Azure CA PEM bundle. Preferred TLS mode. |
| `MYSQL_SSL` | fallback | `true` / `false`; encrypted-but-unverified. Dev only. Ignored if `MYSQL_SSL_CA` is set. |

### 5. Apply the migrations (greenfield)

On the **empty** `exchange` database, apply **all 18 scripts in order** using one of
the three options from [TL;DR](#tldr--what-to-apply).

#### Option A — single file

```sh
mysql \
  -h "$MYSQL_HOST" \
  -P "${MYSQL_PORT:-3306}" \
  -u "$MYSQL_USER" \
  -p"$MYSQL_PASSWORD" \
  --ssl-mode=VERIFY_IDENTITY \
  --ssl-ca="$MYSQL_SSL_CA" \
  "$MYSQL_DATABASE" < sql/schema_init_greenfield.sql
```

#### Option B — numbered folder, one file at a time

```sh
for f in sql/migrations/*.sql; do
  echo ">>> applying $f"
  mysql \
    -h "$MYSQL_HOST" \
    -P "${MYSQL_PORT:-3306}" \
    -u "$MYSQL_USER" \
    -p"$MYSQL_PASSWORD" \
    --ssl-mode=VERIFY_IDENTITY \
    --ssl-ca="$MYSQL_SSL_CA" \
    "$MYSQL_DATABASE" < "$f" || { echo "FAILED on $f"; exit 1; }
done
```

On Windows PowerShell:

```powershell
Get-ChildItem sql\migrations\*.sql | Sort-Object Name | ForEach-Object {
  Write-Host ">>> applying $($_.Name)"
  & mysql `
    -h $env:MYSQL_HOST `
    -P ($env:MYSQL_PORT ? $env:MYSQL_PORT : 3306) `
    -u $env:MYSQL_USER `
    "-p$env:MYSQL_PASSWORD" `
    --ssl-mode=VERIFY_IDENTITY `
    --ssl-ca=$env:MYSQL_SSL_CA `
    $env:MYSQL_DATABASE `
    -e "SOURCE $($_.FullName);"
  if ($LASTEXITCODE -ne 0) { throw "failed on $($_.Name)" }
}
```

#### Optional 19th step

```sh
mysql … "$MYSQL_DATABASE" < sql/optional/enum_union_hardening.sql
```

### 6. Deploy the app

Set the `MYSQL_*` env vars from step 4 in your hosting environment (Vercel
project settings, Azure App Service configuration, Kubernetes secret, etc.)
and deploy. [`db.ts`](../app/lib/db.ts) will pick them up automatically and
connect over TLS.

Verify connectivity after deploy via the health endpoint:

```sh
curl https://<your-app>/api/health/db
```

It returns `{ "ok": true, ... }` when the pool can reach the database.

---

## What files are in this folder

| Path | Purpose |
|---|---|
| [`create_*.sql` / `add_*.sql` / `alter_*.sql` / `link_*.sql` (18 total)](.) | The raw migration files — still here for easy diff review. Apply them in the order of the [migration table](#greenfield-install-18-files-in-order). |
| [`migrations/001_… 018_…`](./migrations/) | Same 18 files, renamed with numeric prefixes so alphabetical sort = apply order. Use for CI / scripted apply. |
| [`schema_init_greenfield.sql`](./schema_init_greenfield.sql) | Concatenation of the 18 numbered files — run once on an empty DB. |
| [`optional/enum_union_hardening.sql`](./optional/enum_union_hardening.sql) | Idempotent enum re-lock. Apply after step 18 for extra safety. |
| `add_oracle_source_columns.sql` | Legacy upgrade only. See [Legacy upgrade script](#legacy-upgrade-script-not-part-of-a-fresh-install). |

---

## Summary

- Fresh Azure Database for MySQL Flexible Server → create DB `exchange` → apply the
  **18** scripts in the given order (single file, numbered folder, or raw) →
  optionally apply the enum hardening → set `MYSQL_*` env vars → deploy.
- Use the **plain username** format (`MYSQL_USER=exchange`), not the legacy
  `user@servername`.
- Use `MYSQL_SSL_CA` in production; `MYSQL_SSL=true` only for dev fallback.
- Skip `add_oracle_source_columns.sql` on fresh databases (legacy upgrade only).
