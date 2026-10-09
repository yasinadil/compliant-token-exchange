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

