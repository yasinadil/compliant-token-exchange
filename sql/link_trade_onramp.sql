-- ============================================================================
-- LINK TRADE ORDERS TO ONRAMP ORDERS
-- ============================================================================
-- Adds a column to trade_orders for linking to Transak onramp orders.
-- When a buy order has a deficit that must be paid via Transak, the
-- corresponding onramp_orders.order_id is stored here.
--
-- Run in MySQL CLI:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/link_trade_onramp.sql;

ALTER TABLE trade_orders
    ADD COLUMN onramp_order_id VARCHAR(64) DEFAULT NULL AFTER balance_swap_tx_id;

ALTER TABLE trade_orders
    ADD INDEX idx_onramp_order_id (onramp_order_id);

-- Add trade_order_id to onramp_orders for reverse lookup
ALTER TABLE onramp_orders
    ADD COLUMN trade_order_id VARCHAR(64) DEFAULT NULL AFTER partner_order_id;

ALTER TABLE onramp_orders
    ADD INDEX idx_trade_order_id (trade_order_id);

-- ============================================================================
-- VERIFY
-- ============================================================================
DESCRIBE trade_orders;
DESCRIBE onramp_orders;
