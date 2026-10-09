-- ============================================================================
-- PLATFORM-LEVEL WALLETS (operator, treasury, …)
-- ============================================================================
-- Stores AES-256-GCM encrypted private keys for platform-managed wallets that
-- are used by backend services on behalf of all users (e.g. the AMM / staking
-- operator). Replaces the previous `OPERATOR_WALLET_PRIVATE_KEY` .env var.
--
-- Encryption key (WALLET_ENCRYPTION_KEY) is the same one used for
-- internal_wallets; see app/lib/wallet-crypto.ts.
--
-- Run in MySQL CLI:
--   mysql> USE exchange;
--   mysql> SOURCE E:/Web Development/Next/exchange/sql/migrations/019_create_platform_wallets.sql;
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    -- Logical role identifier: 'operator' for now, future: 'treasury', ...
    role VARCHAR(32) NOT NULL UNIQUE,
    wallet_address VARCHAR(42) NOT NULL UNIQUE,
    smart_account_address VARCHAR(42) NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    public_key VARCHAR(130) NOT NULL,
    -- User id of the admin who last generated / rotated this wallet
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    rotated_at TIMESTAMP NULL,

    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Extend admin_audit_log action_type ENUM with platform wallet actions so
-- generate / rotate events can be persisted through logAdminAction().
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
        'update_swap_setting',
        'generate_platform_wallet',
        'rotate_platform_wallet'
    ) NOT NULL;
