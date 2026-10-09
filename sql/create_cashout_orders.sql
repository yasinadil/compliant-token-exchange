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
