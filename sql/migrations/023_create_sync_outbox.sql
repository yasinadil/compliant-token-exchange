-- ============================================================================
-- SYNC OUTBOX (transactional outbox for downstream MS SQL Server sync)
-- ============================================================================
-- Reliable data sync from this app's MySQL to an external MS SQL Server REST
-- API. Business Server Actions insert a `sync_outbox` row in the SAME
-- transaction as their business write, so a queued job exists if and only if
-- the data actually changed. A worker (app/api/cron/sync-outbox) later claims
-- pending rows, calls the downstream Insert/Update APIs, and applies
-- exponential-backoff retries + a dead-letter queue.
--
-- Run in MySQL CLI (database name matches your MYSQL_DATABASE, e.g. railway):
--   mysql> USE railway;
--   mysql> SOURCE ./sql/migrations/023_create_sync_outbox.sql;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Monotonic per-aggregate version counter.
--    Each enqueue bumps the counter for (aggregate_type, aggregate_id) so the
--    downstream can reject stale writes (a delayed/reordered older UPDATE can
--    never overwrite newer data). See sync-outbox-service.enqueueSyncJob().
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_aggregate_version (
    aggregate_type VARCHAR(64)  NOT NULL,
    aggregate_id   VARCHAR(191) NOT NULL,
    version        BIGINT       NOT NULL DEFAULT 0,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 2. The queue itself. Each row is one downstream sync job.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_outbox (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_id CHAR(36) NOT NULL UNIQUE,              -- UUID, also the Idempotency-Key sent downstream

    aggregate_type VARCHAR(64) NOT NULL,          -- e.g. 'trade_order', 'cashout_order', 'user'
    aggregate_id   VARCHAR(191) NOT NULL,         -- stable PK of the source row
    operation      ENUM('INSERT','UPDATE') NOT NULL,

    -- Monotonic per-aggregate version so the downstream can reject stale writes.
    aggregate_version BIGINT NOT NULL DEFAULT 0,

    payload JSON NOT NULL,                         -- exact body (envelope) sent to the external API
    payload_version INT NOT NULL DEFAULT 1,        -- schema_version of the payload contract

    status ENUM('pending','processing','completed','failed','dead_letter')
        NOT NULL DEFAULT 'pending',

    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts  INT NOT NULL DEFAULT 8,
    next_retry_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- when eligible to run

    locked_at DATETIME NULL,                       -- claim marker (crash recovery)
    locked_by VARCHAR(64) NULL,

    last_error   TEXT NULL,
    remote_ref   VARCHAR(191) NULL,                -- ID returned by SQL Server (audit)

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Only one open (non-terminal) job per aggregate+operation avoids racing
    -- INSERT/UPDATE jobs for the same row; NULL when terminal so a fresh job
    -- can be enqueued after the previous one completes / dead-letters.
    dedupe_key VARCHAR(255)
        GENERATED ALWAYS AS (
          IF(status IN ('completed','dead_letter'), NULL,
             CONCAT(aggregate_type,':',aggregate_id,':',operation))
        ) STORED,
    UNIQUE KEY uq_open_job (dedupe_key),

    INDEX idx_claim (status, next_retry_at, id),   -- drives the worker poll query
    INDEX idx_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 3. Worker heartbeat (singleton row id=1). Updated on every sweep that runs,
--    so monitoring can alert when the worker hasn't run recently (distinct
--    from an idle-but-healthy queue). last_* capture the most recent sweep.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_outbox_heartbeat (
    id             TINYINT      NOT NULL PRIMARY KEY DEFAULT 1,
    last_run_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_status    VARCHAR(16)  NULL,
    last_claimed   INT          NOT NULL DEFAULT 0,
    last_completed INT          NOT NULL DEFAULT 0,
    last_dead      INT          NOT NULL DEFAULT 0,
    CONSTRAINT chk_heartbeat_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO sync_outbox_heartbeat (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;

-- ----------------------------------------------------------------------------
-- 4. CDC watermark state. The change-data-capture scanner (sync-cdc-service)
--    remembers, per entity, the last (updated_at/created_at, id) it enqueued
--    so each sweep only picks up rows changed since last time. This gives a
--    complete compliance mirror without instrumenting every write site.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_cdc_state (
    entity         VARCHAR(64) NOT NULL PRIMARY KEY,
    last_watermark DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
    last_id        BIGINT      NOT NULL DEFAULT 0,
    updated_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 5. Add updated_at to mutable source tables that lack it, so the CDC scanner
--    re-captures status/amount changes (not just inserts). Safe additive change.
--    NOTE: if a column already exists these ALTERs error harmlessly — skip them.
-- ----------------------------------------------------------------------------
ALTER TABLE staking_orders
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP AFTER completed_at;

ALTER TABLE checkout_charges
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP AFTER created_at;

-- ============================================================================
-- VERIFY
-- ============================================================================
SHOW TABLES LIKE 'sync_%';
DESCRIBE sync_outbox;
DESCRIBE sync_aggregate_version;
DESCRIBE sync_outbox_heartbeat;
DESCRIBE sync_cdc_state;
