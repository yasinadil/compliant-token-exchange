-- ============================================================================
-- CHECKOUT AUDIT LOG
-- ============================================================================
-- One append-only row per Checkout API request (success OR failure). This is
-- the API-surface audit trail — distinct from:
--   * ledger_transactions  = the financial truth (only written when money moves)
--   * admin_audit_log       = human admin dashboard actions
-- It captures rejected/failed attempts (401 bad key, 402 insufficient funds,
-- 400 validation, over-refund) that never touch a balance and are otherwise
-- invisible — the forensically valuable events for disputes, compromised-key
-- investigations, abuse detection, and compliance.
--
-- NOTE: this table is intentionally NOT in SYNC_ENTITIES — it stays local. It
-- holds IP / user-agent, which the sync policy excludes by design.
--
-- Secrets are never stored: we log the presented key *id*, never the secret.
--
-- Run in MySQL CLI (database matches MYSQL_DATABASE, e.g. railway):
--   mysql> USE railway;
--   mysql> SOURCE ./sql/migrations/025_create_checkout_audit_log.sql;
-- ============================================================================

CREATE TABLE IF NOT EXISTS checkout_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id       CHAR(36)     NOT NULL,               -- correlation id (also in logs)

    -- Who
    api_key_id       INT          NULL,                   -- NULL when auth failed / unknown key
    key_id_presented VARCHAR(64)  NULL,                   -- raw presented key id (NEVER the secret)

    -- What
    action           ENUM('charge','refund','balance','get_charge','list_charges') NOT NULL,
    http_method      VARCHAR(8)   NOT NULL,
    user_id          VARCHAR(255) NULL,
    amount           DECIMAL(36,18) NULL,
    currency         VARCHAR(10)  NULL,
    idempotency_key  VARCHAR(255) NULL,
    charge_id        VARCHAR(64)  NULL,
    refund_id        VARCHAR(64)  NULL,

    -- Outcome
    status_code      SMALLINT     NOT NULL,
    success          BOOLEAN      NOT NULL,
    error_message    VARCHAR(512) NULL,

    -- Request context
    ip_address       VARCHAR(64)  NULL,
    user_agent       VARCHAR(512) NULL,
    latency_ms       INT          NULL,

    created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    -- The two lookups you'll actually run: "everything key X did" and
    -- "everything that happened to user Y", both time-ordered.
    INDEX idx_api_key_created (api_key_id, created_at),
    INDEX idx_user_created (user_id, created_at),
    INDEX idx_action_created (action, created_at),
    INDEX idx_created_at (created_at)
    -- Deliberately NO foreign key on api_key_id: an audit insert must never fail
    -- (e.g. logging an attempt with an unknown/NULL key id).
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW COLUMNS FROM checkout_audit_log;
