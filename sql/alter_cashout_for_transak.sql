-- ============================================================================
-- Transak off-ramp: extend cashout_orders
-- Run after create_cashout_orders.sql:
-- mysql> USE exchange;
-- mysql> SOURCE .../alter_cashout_for_transak.sql;
-- ============================================================================

-- Add new status values and Transak columns
ALTER TABLE cashout_orders
  MODIFY COLUMN status ENUM(
    'processing',
    'pending_payout',
    'payout_sent',
    'awaiting_transak',
    'crypto_sent',
    'completed',
    'failed'
  ) NOT NULL DEFAULT 'pending_payout';

ALTER TABLE cashout_orders
  ADD COLUMN transak_order_id VARCHAR(255) NULL AFTER failure_reason,
  ADD COLUMN transak_deposit_address VARCHAR(255) NULL AFTER transak_order_id,
  ADD COLUMN crypto_send_amount DECIMAL(36, 18) NULL AFTER transak_deposit_address,
  ADD COLUMN treasury_tx_hash VARCHAR(66) NULL AFTER crypto_send_amount;

-- Optional index for webhook lookups
CREATE INDEX idx_cashout_transak_order ON cashout_orders (transak_order_id);
CREATE INDEX idx_cashout_transak_status ON cashout_orders (status);

DESCRIBE cashout_orders;
