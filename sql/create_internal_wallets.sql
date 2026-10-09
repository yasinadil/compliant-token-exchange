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

