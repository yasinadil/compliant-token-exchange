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

