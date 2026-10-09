-- SQL Migration: Add balance hold mechanism for pending swap approvals
-- Run this against your MySQL database (exchange)

-- Add held column to internal_balances for tracking locked funds
ALTER TABLE internal_balances
  ADD COLUMN held DECIMAL(36, 18) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_held_positive CHECK (held >= 0);

-- Add hold_transaction_id to pending_swap_approvals to link holds
ALTER TABLE pending_swap_approvals
  ADD COLUMN hold_transaction_id VARCHAR(64) NULL AFTER executed_swap_id;

-- Extend ledger_transactions type ENUM to include hold and hold_release
ALTER TABLE ledger_transactions
  MODIFY COLUMN type ENUM(
    'deposit', 'withdrawal', 'swap_debit', 'swap_credit', 'adjustment',
    'stake_lock', 'stake_unlock', 'stake_reward',
    'checkout_debit', 'checkout_refund',
    'hold', 'hold_release'
  ) NOT NULL;
