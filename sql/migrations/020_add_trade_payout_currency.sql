-- ============================================================================
-- ADD PAYOUT CURRENCY TO TRADE ORDERS
-- ============================================================================
-- Adds support for selling PLAT into a non-USD fiat token.
--
-- Today, sell orders always credit USDX. With this migration, the user can
-- choose to receive USDX, GBPX, EURX, or BRLX. The AMM still swaps
-- PLAT -> USDX; if payout_currency != 'USD', the operator immediately
-- converts the USDX to the chosen fiat via the internal ledger swap.
--
-- Run in MySQL CLI:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/migrations/020_add_trade_payout_currency.sql;

ALTER TABLE trade_orders
    ADD COLUMN payout_currency ENUM('USD', 'BRL', 'GBP', 'EUR') NOT NULL DEFAULT 'USD' AFTER fiat_currency;

ALTER TABLE trade_orders
    ADD COLUMN payout_amount DECIMAL(36, 18) NOT NULL DEFAULT 0 AFTER tusd_amount;

ALTER TABLE trade_orders
    ADD COLUMN payout_swap_transaction_id VARCHAR(64) NULL AFTER credit_transaction_id;

-- Backfill existing rows: payout_currency defaults to 'USD' and payout_amount
-- mirrors tusd_amount for already-completed sell orders so historical reads are
-- consistent.
UPDATE trade_orders
SET payout_amount = tusd_amount
WHERE order_type = 'sell' AND payout_amount = 0;

-- ============================================================================
-- VERIFY
-- ============================================================================
DESCRIBE trade_orders;
