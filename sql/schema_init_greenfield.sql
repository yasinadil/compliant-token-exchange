-- =============================================================================
-- Exchange dApp - Greenfield schema init (Azure Database for MySQL - Flexible Server)
-- =============================================================================
-- This file is a concatenation of the 18 migrations in sql/migrations/ applied
-- in the required order. Run it ONCE against an EMPTY database named `exchange`
-- (or whatever you passed to MYSQL_DATABASE).
--
-- Typical apply (bash / Azure Cloud Shell):
--
--   mysql \
--     -h "$MYSQL_HOST" \
--     -P "${MYSQL_PORT:-3306}" \
--     -u "$MYSQL_USER" \
--     -p"$MYSQL_PASSWORD" \
--     --ssl-mode=VERIFY_IDENTITY \
--     --ssl-ca="$MYSQL_SSL_CA" \
--     "$MYSQL_DATABASE" < schema_init_greenfield.sql
--
-- DO NOT edit and re-run this against an existing database; it is a one-shot
-- greenfield install. For incremental changes in the future, add a new file
-- under sql/migrations/ and apply only that file.
-- =============================================================================


-- =============================================================================
-- >>> 001_create_ledger_tables.sql
-- =============================================================================
-- SQL Migration: Create internal ledger tables for T Fiat swaps
-- Run this against your MySQL database (exchange)

-- User balances per token
CREATE TABLE IF NOT EXISTS internal_balances (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    token_symbol VARCHAR(10) NOT NULL,
    balance DECIMAL(36, 18) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY unique_user_token (user_id, token_symbol),
    INDEX idx_user_id (user_id),
    INDEX idx_token (token_symbol),
    
    CONSTRAINT chk_balance_positive CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Swap transactions - full audit log
CREATE TABLE IF NOT EXISTS swap_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,
    
    -- From side
    from_token VARCHAR(10) NOT NULL,
    from_amount DECIMAL(36, 18) NOT NULL,
    from_balance_before DECIMAL(36, 18) NOT NULL,
    from_balance_after DECIMAL(36, 18) NOT NULL,
    
    -- To side
    to_token VARCHAR(10) NOT NULL,
    to_amount DECIMAL(36, 18) NOT NULL,
    to_balance_before DECIMAL(36, 18) NOT NULL,
    to_balance_after DECIMAL(36, 18) NOT NULL,
    
    -- Exchange rate info
    from_usd_rate DECIMAL(36, 18) NOT NULL,
    to_usd_rate DECIMAL(36, 18) NOT NULL,
    effective_rate DECIMAL(36, 18) NOT NULL,
    
    -- Oracle source tracking (chainlink or pyth)
    from_oracle_source ENUM('chainlink', 'pyth'),
    to_oracle_source ENUM('chainlink', 'pyth'),
    
    -- Oracle data for audit (feed address for Chainlink, feed ID for Pyth)
    oracle_from_feed_id VARCHAR(66),
    oracle_to_feed_id VARCHAR(66),
    oracle_block_number BIGINT,
    oracle_timestamp TIMESTAMP,
    
    -- Metadata
    status ENUM('pending', 'completed', 'failed', 'reversed') NOT NULL DEFAULT 'completed',
    fee_amount DECIMAL(36, 18) DEFAULT 0,
    fee_token VARCHAR(10),
    notes TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_from_token (from_token),
    INDEX idx_to_token (to_token),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_transaction_id (transaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deposit/Withdrawal log for complete audit trail
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,
    
    type ENUM('deposit', 'withdrawal', 'swap_debit', 'swap_credit', 'adjustment') NOT NULL,
    token_symbol VARCHAR(10) NOT NULL,
    amount DECIMAL(36, 18) NOT NULL,
    balance_before DECIMAL(36, 18) NOT NULL,
    balance_after DECIMAL(36, 18) NOT NULL,
    
    -- Reference to related transactions
    related_swap_id INT,
    related_tx_hash VARCHAR(66),
    
    notes TEXT,
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_type (type),
    INDEX idx_token (token_symbol),
    INDEX idx_created_at (created_at),
    
    FOREIGN KEY (related_swap_id) REFERENCES swap_transactions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Supported tokens configuration
CREATE TABLE IF NOT EXISTS supported_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    decimals INT NOT NULL DEFAULT 18,
    is_base_currency BOOLEAN DEFAULT FALSE,
    chainlink_price_feed VARCHAR(42),
    contract_address VARCHAR(42),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert supported T Fiats
INSERT INTO supported_tokens (symbol, name, decimals, is_base_currency, chainlink_price_feed) VALUES
('USDX', 'PLAT Dollar', 18, TRUE, NULL),
('GBPX', 'PLAT Pound', 18, FALSE, '0x4F9Ad1BEff0B7C8B3A1c3C5C9C5C9C5C9C5C9C5C'),
('EURX', 'PLAT Euro', 18, FALSE, '0x5F4eC3Df9cbd43714FE2740f5E3616155c5b8419'),
('BRLX', 'PLAT Real', 18, FALSE, '0x971E8F1B779A5F1C36e1cd7ef44Ba1Cc2F5EeE0f')
ON DUPLICATE KEY UPDATE name = VALUES(name);



-- =============================================================================
-- >>> 002_add_security_tables.sql
-- =============================================================================
-- SQL Migration: Add security and admin control tables
-- Run this against your MySQL database (exchange)

-- User swap settings and controls
CREATE TABLE IF NOT EXISTS user_swap_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    is_swap_paused BOOLEAN DEFAULT FALSE,
    pause_reason TEXT,
    paused_by VARCHAR(255),
    paused_at TIMESTAMP NULL,
    daily_limit_usd DECIMAL(20, 2) NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_paused (is_swap_paused)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pending approvals for large transactions
CREATE TABLE IF NOT EXISTS pending_swap_approvals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    approval_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,
    
    -- Swap details
    from_token VARCHAR(10) NOT NULL,
    from_amount DECIMAL(36, 18) NOT NULL,
    to_token VARCHAR(10) NOT NULL,
    estimated_to_amount DECIMAL(36, 18) NOT NULL,
    usd_value DECIMAL(20, 2) NOT NULL,
    
    -- Rate at time of request
    from_usd_rate DECIMAL(36, 18) NOT NULL,
    to_usd_rate DECIMAL(36, 18) NOT NULL,
    
    -- Status
    status ENUM('pending', 'approved', 'rejected', 'expired', 'executed') NOT NULL DEFAULT 'pending',
    
    -- Admin action
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    
    -- Execution reference
    executed_swap_id INT,
    
    -- Metadata
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_expires_at (expires_at),
    
    FOREIGN KEY (executed_swap_id) REFERENCES swap_transactions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limiting tracking (recent swaps per user)
CREATE TABLE IF NOT EXISTS swap_rate_limits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    swap_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_timestamp (user_id, swap_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Daily swap totals (for $10K daily limit tracking)
CREATE TABLE IF NOT EXISTS daily_swap_totals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    swap_date DATE NOT NULL,
    total_usd_value DECIMAL(20, 2) NOT NULL DEFAULT 0,
    swap_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY unique_user_date (user_id, swap_date),
    INDEX idx_user_id (user_id),
    INDEX idx_date (swap_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: Admin roles are determined by the auth API (the identity provider/api/Auth)
-- The Roles array in the auth response contains "Admin" for admin users
-- No separate admin_users table is needed

-- Admin action audit log
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    admin_user_id VARCHAR(255) NOT NULL,
    action_type ENUM('approve_swap', 'reject_swap', 'pause_user', 'unpause_user', 'add_admin', 'remove_admin', 'adjust_limit') NOT NULL,
    target_user_id VARCHAR(255),
    target_approval_id VARCHAR(64),
    details JSON,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_admin (admin_user_id),
    INDEX idx_action (action_type),
    INDEX idx_target_user (target_user_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cleanup old rate limit entries (run periodically)
-- DELETE FROM swap_rate_limits WHERE swap_timestamp < DATE_SUB(NOW(), INTERVAL 5 MINUTE);



-- =============================================================================
-- >>> 003_alter_user_swap_daily_limit_null_default.sql
-- =============================================================================
-- Daily USD cap is enforced only from swap_platform_settings.daily_volume_limit_usd (app code).
-- This column is reserved for a possible future per-user override; it must not shadow the platform default.

ALTER TABLE user_swap_settings
  MODIFY COLUMN daily_limit_usd DECIMAL(20, 2) NULL DEFAULT NULL;

-- Clear legacy implicit defaults so nothing in the DB suggests a per-user cap.
UPDATE user_swap_settings SET daily_limit_usd = NULL;


-- =============================================================================
-- >>> 004_create_internal_wallets.sql
-- =============================================================================
-- SQL Migration: Create internal_wallets table
-- Run this against your MySQL database (exchange)

CREATE TABLE IF NOT EXISTS internal_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    wallet_address VARCHAR(42) NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    public_key VARCHAR(130) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_wallet_address (wallet_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note: encrypted_private_key stores AES-256-GCM encrypted private key
-- The encryption key should be stored in environment variable WALLET_ENCRYPTION_KEY



-- =============================================================================
-- >>> 005_add_smart_account_address.sql
-- =============================================================================
-- SQL Migration: Add smart_account_address column to internal_wallets
-- This stores the deterministic Safe smart account address used for gasless (Pimlico) transactions

ALTER TABLE internal_wallets
    ADD COLUMN smart_account_address VARCHAR(42) DEFAULT NULL AFTER wallet_address,
    ADD UNIQUE INDEX idx_smart_account_address (smart_account_address);


-- =============================================================================
-- >>> 006_create_swap_platform_settings.sql
-- =============================================================================
-- Configurable platform-wide swap settings (managed via admin panel)
-- Stores key-value pairs for rate limits, daily volume limits, etc.

CREATE TABLE IF NOT EXISTS swap_platform_settings (
  setting_key   VARCHAR(100)  PRIMARY KEY,
  setting_value VARCHAR(255)  NOT NULL,
  description   VARCHAR(500)  NULL,
  updated_by    VARCHAR(100)  NULL,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default settings
INSERT INTO swap_platform_settings (setting_key, setting_value, description) VALUES
  ('max_trades_per_day',      '20',    'Maximum number of fiat swap trades a user can make per day'),
  ('daily_volume_limit_usd',  '10000', 'Maximum daily swap volume per user in USD'),
  ('approval_threshold_usd',  '5000',  'Swap USD value at or above which admin approval is required'),
  ('kyc_required',            'true',  'Whether KYC verification is required to use fiat swaps'),
  ('kyc_required_trade',      'true',  'Whether KYC verification is required to use AMM trading')
ON DUPLICATE KEY UPDATE setting_key = setting_key;



-- =============================================================================
-- >>> 007_create_trade_orders.sql
-- =============================================================================
-- ============================================================================
-- TRADE ORDERS TABLE FOR FIAT-TO-PLAT TRADING
-- ============================================================================
-- Run this in MySQL CLI after selecting the exchange database:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/create_trade_orders.sql;

-- ============================================================================
-- TRADE ORDERS TABLE
-- ============================================================================
-- Tracks buy/sell PLAT orders through their full lifecycle

CREATE TABLE IF NOT EXISTS trade_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,

    -- Order type and status
    order_type ENUM('buy', 'sell') NOT NULL,
    status ENUM(
        'pending_payment',   -- Buy: waiting for fiat payment
        'payment_received',  -- Buy: payment confirmed, awaiting execution
        'executing',         -- Operator AMM swap in progress
        'completed',         -- Successfully completed
        'slippage_fallback', -- Buy: slippage exceeded, USDX credited instead
        'failed',            -- Execution failed
        'cancelled'          -- User or system cancelled
    ) NOT NULL DEFAULT 'pending_payment',

    -- Fiat side
    fiat_currency ENUM('USD', 'BRL', 'GBP', 'EUR') NOT NULL,
    -- Sell payout: which fiat the user receives. Buy orders ignore this.
    payout_currency ENUM('USD', 'BRL', 'GBP', 'EUR') NOT NULL DEFAULT 'USD',
    fiat_amount DECIMAL(18, 2) NOT NULL,
    fiat_to_tusd_rate DECIMAL(36, 18) NOT NULL DEFAULT 1,

    -- USDX equivalent
    tusd_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,
    -- Final amount credited in payout_currency (sell orders). For USD payouts
    -- this equals tusd_amount.
    payout_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,

    -- PLAT side
    tglobal_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,

    -- AMM pricing
    amm_quote_price DECIMAL(36, 18),
    executed_price DECIMAL(36, 18),
    slippage_bps INT DEFAULT 0,
    max_slippage_bps INT NOT NULL DEFAULT 200,

    -- Operator execution
    operator_tx_hash VARCHAR(66),
    operator_smart_account VARCHAR(42),

    -- Payment tracking
    payment_reference VARCHAR(255),
    payment_provider VARCHAR(50) DEFAULT 'mock',

    -- Ledger references
    credit_transaction_id VARCHAR(64),
    payout_swap_transaction_id VARCHAR(64) NULL,
    debit_transaction_id VARCHAR(64),

    -- Error / notes
    failure_reason TEXT,
    notes TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    executed_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_order_type (order_type),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_payment_ref (payment_reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- PAYMENT WEBHOOK LOGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_webhook_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    raw_payload JSON NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    process_result VARCHAR(255),
    error_message TEXT,
    signature VARCHAR(255),
    signature_valid BOOLEAN,
    ip_address VARCHAR(45),
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,

    INDEX idx_event_id (event_id),
    INDEX idx_provider (provider),
    INDEX idx_processed (processed),
    INDEX idx_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ADD PLAT TO SUPPORTED TOKENS
-- ============================================================================

INSERT INTO supported_tokens (symbol, name, decimals, is_base_currency, contract_address)
VALUES ('PLAT', 'PLAT Global', 18, FALSE, '0x196E4d189D5A81595AEa82b6A755742D894CFC73')
ON DUPLICATE KEY UPDATE name = VALUES(name), contract_address = VALUES(contract_address);

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW TABLES LIKE 'trade%';
SHOW TABLES LIKE 'payment_webhook%';
SELECT * FROM supported_tokens WHERE symbol = 'PLAT';


-- =============================================================================
-- >>> 008_add_balance_buy_columns.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 009_add_deferred_trade_statuses.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 010_create_onramp_tables.sql
-- =============================================================================
-- ============================================================================
-- ON-RAMP TABLES FOR TRANSAK INTEGRATION
-- ============================================================================
-- Run this in MySQL CLI after selecting the exchange database:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/create_onramp_tables.sql;

-- ============================================================================
-- ON-RAMP ORDERS TABLE
-- ============================================================================
-- Tracks all on-ramp transactions from Transak

CREATE TABLE IF NOT EXISTS onramp_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    
    -- Internal order tracking
    order_id VARCHAR(64) NOT NULL UNIQUE,
    partner_order_id VARCHAR(64) NOT NULL UNIQUE, -- Sent to Transak for tracking
    
    -- Transak order tracking
    transak_order_id VARCHAR(64) UNIQUE,
    
    -- User
    user_id VARCHAR(255) NOT NULL,
    
    -- Fiat side
    fiat_currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    fiat_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
    
    -- Crypto side (what Transak sends to treasury)
    crypto_currency VARCHAR(10) NOT NULL DEFAULT 'USDC',
    crypto_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,
    
    -- USDX credited to user (1:1 with stablecoin)
    tusd_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,
    
    -- Status tracking
    status ENUM('pending', 'processing', 'completed', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
    transak_status VARCHAR(50), -- Raw status from Transak
    
    -- Transaction details
    treasury_tx_hash VARCHAR(66), -- On-chain tx hash to treasury
    credit_transaction_id VARCHAR(64), -- Our internal ledger tx ID
    
    -- Error handling
    failure_reason TEXT,
    
    -- Raw webhook payload for auditing
    webhook_payload JSON,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    
    -- Indexes for common queries
    INDEX idx_user_id (user_id),
    INDEX idx_transak_order_id (transak_order_id),
    INDEX idx_partner_order_id (partner_order_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
    
    -- Foreign key (optional - if users table exists)
    -- FOREIGN KEY (user_id) REFERENCES users(id)
    
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- WEBHOOK EVENTS LOG TABLE
-- ============================================================================
-- Logs all incoming webhooks for auditing and replay

CREATE TABLE IF NOT EXISTS onramp_webhook_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    
    -- Webhook identification
    event_id VARCHAR(64) NOT NULL,
    transak_order_id VARCHAR(64),
    
    -- Raw payload
    raw_payload JSON NOT NULL,
    
    -- Processing result
    processed BOOLEAN DEFAULT FALSE,
    process_result VARCHAR(255),
    error_message TEXT,
    
    -- Security
    signature VARCHAR(128),
    signature_valid BOOLEAN,
    ip_address VARCHAR(45),
    
    -- Timestamp
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    
    -- Indexes
    INDEX idx_event_id (event_id),
    INDEX idx_transak_order_id (transak_order_id),
    INDEX idx_processed (processed),
    INDEX idx_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VERIFY TABLES
-- ============================================================================
SHOW TABLES LIKE 'onramp%';
DESCRIBE onramp_orders;



-- =============================================================================
-- >>> 011_link_trade_onramp.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 012_create_cashout_orders.sql
-- =============================================================================
-- ============================================================================
-- CASHOUT ORDERS TABLE
-- ============================================================================
-- Run this in MySQL CLI after selecting the exchange database:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/create_cashout_orders.sql;
--
-- Tracks cashout (offramp) requests: internal ledger token -> fiat bank payout
-- Supports all internal ledger tokens: USDX, GBPX, EURX, BRLX, PLAT

CREATE TABLE IF NOT EXISTS cashout_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cashout_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,

    -- Source token
    token VARCHAR(20) NOT NULL,
    token_amount DECIMAL(36, 18) NOT NULL,

    -- USDX equivalent after conversion (oracle rate or AMM swap)
    tusd_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,
    conversion_rate DECIMAL(36, 18) NOT NULL DEFAULT 1,

    -- For PLAT: AMM swap details
    amm_executed_price DECIMAL(36, 18),
    amm_slippage_bps INT DEFAULT 0,
    operator_tx_hash VARCHAR(66),

    -- Fiat payout
    fiat_currency ENUM('USD', 'BRL', 'GBP', 'EUR') NOT NULL DEFAULT 'USD',
    fiat_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,

    -- Status
    status ENUM(
        'processing',       -- AMM swap in progress (PLAT only)
        'pending_payout',   -- Waiting for admin to send bank transfer
        'payout_sent',      -- Admin has sent the payout
        'completed',        -- Confirmed complete
        'failed'            -- Something went wrong
    ) NOT NULL DEFAULT 'pending_payout',

    -- Bank details (encrypted JSON in production)
    bank_details_encrypted TEXT,

    -- Ledger references
    debit_transaction_id VARCHAR(64),

    -- Admin processing
    payment_reference VARCHAR(255),
    processed_by VARCHAR(255),
    processed_at TIMESTAMP NULL,
    process_notes TEXT,

    failure_reason TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user_id (user_id),
    INDEX idx_token (token),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW TABLES LIKE 'cashout%';
DESCRIBE cashout_orders;


-- =============================================================================
-- >>> 013_alter_cashout_for_transak.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 014_create_staking_orders.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 015_create_checkout_tables.sql
-- =============================================================================
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



-- =============================================================================
-- >>> 016_add_balance_hold.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 017_add_processing_fee.sql
-- =============================================================================
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


-- =============================================================================
-- >>> 018_add_idempotency_keys.sql
-- =============================================================================
-- ============================================================================
-- IDEMPOTENCY KEYS FOR LEDGER / TRADE / CASHOUT
-- ============================================================================
-- Adds idempotency_key columns + unique indexes so duplicate credits and
-- duplicate order creations are rejected by the database, not only by app
-- logic. Used by the Transak webhook path, trade/cashout order creation,
-- and client-supplied retries.
--
-- Run in MySQL CLI:
--   mysql> USE exchange;
--   mysql> SOURCE E:/Web Development/Next/exchange/sql/add_idempotency_keys.sql;
-- ============================================================================

-- 1. ledger_transactions: global idempotency for credits/debits.
--    Unique index permits multiple NULLs (MySQL behaviour), so existing
--    rows without a key are not affected.
ALTER TABLE ledger_transactions
  ADD COLUMN idempotency_key VARCHAR(191) DEFAULT NULL AFTER created_by,
  ADD UNIQUE INDEX idx_ledger_idempotency (idempotency_key);

-- 2. trade_orders: client-supplied dedup key (scoped per user).
ALTER TABLE trade_orders
  ADD COLUMN idempotency_key VARCHAR(191) DEFAULT NULL AFTER notes,
  ADD UNIQUE INDEX idx_trade_idempotency (user_id, idempotency_key);

-- 3. cashout_orders: client-supplied dedup key (scoped per user).
ALTER TABLE cashout_orders
  ADD COLUMN idempotency_key VARCHAR(191) DEFAULT NULL AFTER process_notes,
  ADD UNIQUE INDEX idx_cashout_idempotency (user_id, idempotency_key);

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW INDEX FROM ledger_transactions WHERE Key_name = 'idx_ledger_idempotency';
SHOW INDEX FROM trade_orders        WHERE Key_name = 'idx_trade_idempotency';
SHOW INDEX FROM cashout_orders      WHERE Key_name = 'idx_cashout_idempotency';


-- =============================================================================
-- >>> 019_create_platform_wallets.sql
-- =============================================================================
-- ============================================================================
-- PLATFORM-LEVEL WALLETS (operator, treasury, ...)
-- ============================================================================
-- Stores AES-256-GCM encrypted private keys for platform-managed wallets that
-- are used by backend services on behalf of all users (e.g. the AMM / staking
-- operator). Replaces the previous `OPERATOR_WALLET_PRIVATE_KEY` .env var.
--
-- Encryption key (WALLET_ENCRYPTION_KEY) is the same one used for
-- internal_wallets; see app/lib/wallet-crypto.ts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    role VARCHAR(32) NOT NULL UNIQUE,
    wallet_address VARCHAR(42) NOT NULL UNIQUE,
    smart_account_address VARCHAR(42) NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    public_key VARCHAR(130) NOT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    rotated_at TIMESTAMP NULL,

    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Extend admin_audit_log action_type ENUM with platform wallet actions
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
