-- ============================================================================
-- IDEMPOTENCY KEYS FOR LEDGER / TRADE / CASHOUT
-- ============================================================================
-- Adds idempotency_key columns + unique indexes so duplicate credits and
-- duplicate order creations are rejected by the database, not only by app
-- logic. Used by the Transak webhook path, trade/cashout order creation,
-- and client-supplied retries.
--
-- Run in MySQL CLI:
--   mysql> USE exchange;
--   mysql> SOURCE E:/Web Development/Next/exchange/sql/add_idempotency_keys.sql;
-- ============================================================================

-- 1. ledger_transactions: global idempotency for credits/debits.
--    Unique index permits multiple NULLs (MySQL behaviour), so existing
--    rows without a key are not affected.
ALTER TABLE ledger_transactions
  ADD COLUMN idempotency_key VARCHAR(191) DEFAULT NULL AFTER created_by,
  ADD UNIQUE INDEX idx_ledger_idempotency (idempotency_key);

-- 2. trade_orders: client-supplied dedup key (scoped per user).
ALTER TABLE trade_orders
  ADD COLUMN idempotency_key VARCHAR(191) DEFAULT NULL AFTER notes,
  ADD UNIQUE INDEX idx_trade_idempotency (user_id, idempotency_key);

-- 3. cashout_orders: client-supplied dedup key (scoped per user).
ALTER TABLE cashout_orders
  ADD COLUMN idempotency_key VARCHAR(191) DEFAULT NULL AFTER process_notes,
  ADD UNIQUE INDEX idx_cashout_idempotency (user_id, idempotency_key);

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW INDEX FROM ledger_transactions WHERE Key_name = 'idx_ledger_idempotency';
SHOW INDEX FROM trade_orders        WHERE Key_name = 'idx_trade_idempotency';
SHOW INDEX FROM cashout_orders      WHERE Key_name = 'idx_cashout_idempotency';
