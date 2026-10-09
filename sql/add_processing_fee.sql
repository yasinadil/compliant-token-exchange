-- ============================================================================
-- ADD PROCESSING FEE INFRASTRUCTURE
-- ============================================================================
-- Adds configurable processing fee (basis points) for AMM trade orders.
-- Default is 0 bps (no fee). Admin can configure via the Swap Settings panel.
--
-- Run in MySQL CLI:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/add_processing_fee.sql;

-- 1. Platform setting for processing fee (default 0 bps = no fee)
INSERT INTO swap_platform_settings (setting_key, setting_value, description) VALUES
  ('processing_fee_bps', '0', 'Processing fee in basis points applied to trades and fiat swaps (0 = disabled, 100 = 1%)')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- 2. Add fee columns to trade_orders
ALTER TABLE trade_orders
  ADD COLUMN fee_bps INT NOT NULL DEFAULT 0 AFTER max_slippage_bps,
  ADD COLUMN fee_usdx DECIMAL(36, 18) NOT NULL DEFAULT 0 AFTER fee_bps;

-- 3. Collected fees ledger for audit trail
CREATE TABLE IF NOT EXISTS collected_fees (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  order_type ENUM('buy', 'sell', 'swap') NOT NULL,
  fee_bps INT NOT NULL,
  gross_usdx DECIMAL(36, 18) NOT NULL,
  fee_usdx DECIMAL(36, 18) NOT NULL,
  net_usdx DECIMAL(36, 18) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_order_id (order_id),
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Extend admin_audit_log action_type ENUM with update_swap_setting
ALTER TABLE admin_audit_log
    MODIFY COLUMN action_type ENUM(
        'approve_swap',
        'reject_swap',
        'pause_user',
        'unpause_user',
        'add_admin',
        'remove_admin',
        'adjust_limit',
        'create_checkout_api_key',
        'revoke_checkout_api_key',
        'update_swap_setting'
    ) NOT NULL;

-- 5. Extend collected_fees order_type ENUM to include 'swap' for fiat-to-fiat swaps
ALTER TABLE collected_fees
    MODIFY COLUMN order_type ENUM('buy', 'sell', 'swap') NOT NULL;

-- ============================================================================
-- VERIFY
-- ============================================================================
SELECT setting_key, setting_value FROM swap_platform_settings WHERE setting_key = 'processing_fee_bps';
DESCRIBE trade_orders;
DESCRIBE collected_fees;
