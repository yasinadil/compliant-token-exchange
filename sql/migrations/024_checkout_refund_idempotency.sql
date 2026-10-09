-- ============================================================================
-- CHECKOUT REFUND IDEMPOTENCY
-- ============================================================================
-- The checkout refund endpoint previously had no idempotency key, so a retried
-- refund request (client timeout + retry) or two concurrent partial refunds
-- could credit a user's balance more than once. This adds a per-API-key
-- idempotency key to checkout_refunds so a repeated refund with the same key is
-- a no-op that returns the original result (mirrors checkout_charges).
--
-- Column is NULLable so any pre-existing rows remain valid; MySQL permits
-- multiple NULLs under a UNIQUE index, so only real (non-NULL) keys are deduped.
--
-- Run in MySQL CLI (database matches MYSQL_DATABASE, e.g. railway):
--   mysql> USE railway;
--   mysql> SOURCE ./sql/migrations/024_checkout_refund_idempotency.sql;
-- ============================================================================

ALTER TABLE checkout_refunds
  ADD COLUMN idempotency_key VARCHAR(255) NULL AFTER reason,
  ADD UNIQUE KEY unique_refund_idempotency (api_key_id, idempotency_key);

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW COLUMNS FROM checkout_refunds LIKE 'idempotency_key';
SHOW INDEX FROM checkout_refunds WHERE Key_name = 'unique_refund_idempotency';
