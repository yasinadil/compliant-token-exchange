-- SQL Migration: Create checkout API tables for external balance charges
-- Run this against your MySQL database (exchange)

-- ============================================================================
-- API Key Management
-- ============================================================================
CREATE TABLE IF NOT EXISTS checkout_api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_id VARCHAR(20) NOT NULL UNIQUE,
    secret_hash VARCHAR(64) NOT NULL,
    name VARCHAR(100) NOT NULL,
    permissions JSON NOT NULL DEFAULT ('["charge","refund","balance"]'),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP NULL DEFAULT NULL,

    INDEX idx_key_id (key_id),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- Checkout Charges (balance debits from external API)
-- ============================================================================
CREATE TABLE IF NOT EXISTS checkout_charges (
    id INT AUTO_INCREMENT PRIMARY KEY,
    charge_id VARCHAR(64) NOT NULL UNIQUE,
    api_key_id INT NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    amount DECIMAL(36, 18) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'PLAT',
    status ENUM('completed', 'refunded', 'partially_refunded') NOT NULL DEFAULT 'completed',
    description TEXT,
    reference VARCHAR(255) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    ledger_transaction_id VARCHAR(64) NOT NULL,
    refunded_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY unique_idempotency (api_key_id, idempotency_key),
    INDEX idx_charge_id (charge_id),
    INDEX idx_user_id (user_id),
    INDEX idx_reference (reference),
    INDEX idx_api_key (api_key_id),
    INDEX idx_created_at (created_at),

    FOREIGN KEY (api_key_id) REFERENCES checkout_api_keys(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- Checkout Refunds (balance credits back from external API)
-- ============================================================================
CREATE TABLE IF NOT EXISTS checkout_refunds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    refund_id VARCHAR(64) NOT NULL UNIQUE,
    charge_id VARCHAR(64) NOT NULL,
    api_key_id INT NOT NULL,
    amount DECIMAL(36, 18) NOT NULL,
    reason TEXT,
    status ENUM('completed', 'failed') NOT NULL DEFAULT 'completed',
    ledger_transaction_id VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_refund_id (refund_id),
    INDEX idx_charge_id (charge_id),
    INDEX idx_created_at (created_at),

    FOREIGN KEY (api_key_id) REFERENCES checkout_api_keys(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- Extend ledger_transactions ENUM to include checkout types
-- ============================================================================
ALTER TABLE ledger_transactions
    MODIFY COLUMN type ENUM(
        'deposit',
        'withdrawal',
        'swap_debit',
        'swap_credit',
        'adjustment',
        'stake_lock',
        'stake_unlock',
        'stake_reward',
        'checkout_debit',
        'checkout_refund'
    ) NOT NULL;

-- ============================================================================
-- Extend admin_audit_log action_type ENUM for checkout key management
-- ============================================================================
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
        'revoke_checkout_api_key'
    ) NOT NULL;

