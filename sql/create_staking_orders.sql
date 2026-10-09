-- ============================================================================
-- STAKING ORDERS TABLE FOR OPERATOR-DELEGATED STAKING
-- ============================================================================
-- Run this in MySQL CLI after selecting the exchange database:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/create_staking_orders.sql;

-- ============================================================================
-- STAKING ORDERS TABLE
-- ============================================================================
-- Tracks stake/unstake/claim/emergency_withdraw orders through their lifecycle

CREATE TABLE IF NOT EXISTS staking_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,
    user_smart_account VARCHAR(42) NOT NULL,

    -- Order type and status
    order_type ENUM('stake', 'unstake', 'claim', 'emergency_withdraw') NOT NULL,
    status ENUM('pending', 'executing', 'completed', 'failed') NOT NULL DEFAULT 'pending',

    -- Amounts
    amount DECIMAL(36, 18) NOT NULL DEFAULT 0,
    reward_amount DECIMAL(36, 18) DEFAULT NULL,

    -- Operator execution
    operator_tx_hash VARCHAR(66) DEFAULT NULL,

    -- Ledger references
    debit_transaction_id VARCHAR(64) DEFAULT NULL,
    credit_transaction_id VARCHAR(64) DEFAULT NULL,
    reward_credit_transaction_id VARCHAR(64) DEFAULT NULL,

    -- Error tracking
    failure_reason TEXT DEFAULT NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    executed_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_order_type (order_type),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ADD STAKING TRANSACTION TYPES TO LEDGER
-- ============================================================================
-- Extend the ledger_transactions type enum to include staking types

ALTER TABLE ledger_transactions
    MODIFY COLUMN type ENUM(
        'deposit',
        'withdrawal',
        'swap_debit',
        'swap_credit',
        'adjustment',
        'stake_lock',
        'stake_unlock',
        'stake_reward'
    ) NOT NULL;

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW TABLES LIKE 'staking%';
DESCRIBE staking_orders;
SHOW COLUMNS FROM ledger_transactions LIKE 'type';
