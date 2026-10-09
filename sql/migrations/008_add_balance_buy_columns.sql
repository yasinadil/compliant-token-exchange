-- ============================================================================
-- ADD BALANCE-AWARE BUY COLUMNS TO TRADE_ORDERS
-- ============================================================================
-- Tracks how much of a buy order was funded from internal platform-token balance
-- vs. charged via payment provider.
--
-- Run in MySQL CLI:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/add_balance_buy_columns.sql;

-- Which platform-token was debited from user's internal balance (USDX/GBPX/EURX/BRLX)
ALTER TABLE trade_orders
    ADD COLUMN balance_token VARCHAR(10) DEFAULT NULL AFTER payment_provider;

-- Amount debited from balance in original token denomination
ALTER TABLE trade_orders
    ADD COLUMN balance_amount DECIMAL(36, 18) NOT NULL DEFAULT 0 AFTER balance_token;

-- USDX value of the balance-sourced portion (after oracle conversion for non-USDX)
ALTER TABLE trade_orders
    ADD COLUMN balance_tusd_equivalent DECIMAL(36, 18) NOT NULL DEFAULT 0 AFTER balance_amount;

-- Fiat amount charged via payment provider (the deficit)
ALTER TABLE trade_orders
    ADD COLUMN charged_fiat_amount DECIMAL(18, 2) NOT NULL DEFAULT 0 AFTER balance_tusd_equivalent;

-- Ledger transaction ID for the balance debit
ALTER TABLE trade_orders
    ADD COLUMN balance_debit_tx_id VARCHAR(64) DEFAULT NULL AFTER charged_fiat_amount;

-- Internal swap transaction ID (non-null when non-USDX token was converted to USDX)
ALTER TABLE trade_orders
    ADD COLUMN balance_swap_tx_id VARCHAR(64) DEFAULT NULL AFTER balance_debit_tx_id;

-- ============================================================================
-- VERIFY
-- ============================================================================
DESCRIBE trade_orders;
