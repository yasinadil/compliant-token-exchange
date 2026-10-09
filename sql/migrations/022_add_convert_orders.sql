-- ============================================================================
-- ADD CONVERT ORDER TYPE TO TRADE ORDERS
-- ============================================================================
-- Adds support for "Convert" operations that involve PLAT on either side.
-- Stable ↔ stable conversions continue to flow through swap_transactions
-- (ledger-only). Convert rows captured here are the PLAT-involving
-- variants:
--   • USDX                   ↔ PLAT  → one AMM hop (operator-mediated)
--   • EURX / GBPX / BRLX   ↔ PLAT  → two-leg: ledger swap + AMM hop
--
-- The new columns capture the user-facing direction (from_token →
-- to_token + amounts) so the activity feed can render a single
-- "Convert X → Y" row regardless of how many primitives ran underneath.
-- For two-leg cases, the ledger leg writes to swap_transactions as usual;
-- the activity feed dedupes those rows by joining against this trade
-- order's payout_swap_transaction_id (existing column from migration 020,
-- repurposed here).
--
-- Run in MySQL CLI:
-- mysql> USE railway;
-- mysql> SOURCE D:/Workstation/_Junior/Dapp/Claude\ Test/sql/migrations/022_add_convert_orders.sql;

-- 1. Add 'convert' to the order_type enum, alongside existing buy / sell.
ALTER TABLE trade_orders
    MODIFY COLUMN order_type ENUM('buy', 'sell', 'convert') NOT NULL;

-- 2. Capture the user-facing direction on convert rows. Nullable so existing
--    buy / sell rows (and any future trade_orders pattern) aren't forced to
--    populate them.
ALTER TABLE trade_orders
    ADD COLUMN from_token VARCHAR(16) NULL AFTER order_type,
    ADD COLUMN to_token   VARCHAR(16) NULL AFTER from_token,
    ADD COLUMN from_amount DECIMAL(36, 18) NULL AFTER to_token,
    ADD COLUMN to_amount   DECIMAL(36, 18) NULL AFTER from_amount;

-- ============================================================================
-- VERIFY
-- ============================================================================
DESCRIBE trade_orders;
