-- SQL Migration: Add smart_account_address column to internal_wallets
-- This stores the deterministic Safe smart account address used for gasless (Pimlico) transactions

ALTER TABLE internal_wallets
    ADD COLUMN smart_account_address VARCHAR(42) DEFAULT NULL AFTER wallet_address,
    ADD UNIQUE INDEX idx_smart_account_address (smart_account_address);
