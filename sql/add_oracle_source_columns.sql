-- SQL Migration: Add oracle source tracking to swap_transactions
-- Run this against your MySQL database (exchange)
-- This allows tracking whether Chainlink or Pyth was used for each price

-- Rename chainlink-specific columns to generic oracle columns
ALTER TABLE swap_transactions
    -- Add oracle source columns
    ADD COLUMN from_oracle_source ENUM('chainlink', 'pyth') NULL AFTER effective_rate,
    ADD COLUMN to_oracle_source ENUM('chainlink', 'pyth') NULL AFTER from_oracle_source,
    
    -- Rename chainlink columns to generic oracle columns (keep old for backward compat)
    CHANGE COLUMN chainlink_from_price_feed oracle_from_feed_id VARCHAR(66) NULL,
    CHANGE COLUMN chainlink_to_price_feed oracle_to_feed_id VARCHAR(66) NULL,
    CHANGE COLUMN chainlink_block_number oracle_block_number BIGINT NULL,
    CHANGE COLUMN chainlink_timestamp oracle_timestamp TIMESTAMP NULL;

-- Add index for oracle source queries
ALTER TABLE swap_transactions
    ADD INDEX idx_from_oracle_source (from_oracle_source),
    ADD INDEX idx_to_oracle_source (to_oracle_source);

