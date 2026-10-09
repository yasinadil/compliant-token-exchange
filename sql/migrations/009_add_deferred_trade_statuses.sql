-- ============================================================================
-- ADD DEFERRED TRADE EXECUTION STATUSES
-- ============================================================================
-- Adds price_changed and insufficient_balance statuses for orders where
-- Transak payment arrived but the trade couldn't auto-execute.
--
-- Run: mysql> USE exchange;
-- Run: mysql> SOURCE E:/Web Development/Next/exchange/sql/add_deferred_trade_statuses.sql;

ALTER TABLE trade_orders
  MODIFY COLUMN status ENUM(
    'pending_payment',
    'payment_received',
    'executing',
    'completed',
    'slippage_fallback',
    'price_changed',
    'insufficient_balance',
    'failed',
    'cancelled'
  ) NOT NULL DEFAULT 'pending_payment';
