-- =============================================================================
-- OPTIONAL HARDENING: lock both reorderable ENUMs to the full union of values
-- =============================================================================
-- Several of the 18 greenfield migrations use `ALTER TABLE ... MODIFY COLUMN
-- <col> ENUM(...)` which REPLACES the full enum list. That means if anyone
-- ever re-runs (or out-of-orders) steps 14, 15, 16, 17 later, values currently
-- in the column can be silently dropped.
--
-- Running this script AFTER step 18 forces both affected columns to the full
-- union of every value the app uses today. It is idempotent and safe to re-run.
--
-- When to apply:
--   - After the initial 18-step greenfield install, as a 19th step, if you
--     want maximum safety against future reorder / re-run mistakes.
--   - Not required for a one-shot greenfield install that will never be
--     replayed — the final states of step 16 (ledger_transactions.type) and
--     step 17 (admin_audit_log.action_type) already contain these unions.
-- =============================================================================

-- ledger_transactions.type: final union across steps 1, 14, 15, 16
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
        'checkout_refund',
        'hold',
        'hold_release'
    ) NOT NULL;

-- admin_audit_log.action_type: final union across steps 2, 15, 17
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

-- =============================================================================
-- VERIFY
-- =============================================================================
SHOW COLUMNS FROM ledger_transactions LIKE 'type';
SHOW COLUMNS FROM admin_audit_log LIKE 'action_type';
