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
    fiat_amount DECIMAL(18, 2) NOT NULL,
    fiat_to_tusd_rate DECIMAL(36, 18) NOT NULL DEFAULT 1,

    -- USDX equivalent
    tusd_amount DECIMAL(36, 18) NOT NULL DEFAULT 0,

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
