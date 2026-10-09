-- ============================================================================
-- ADD TARGET TOKEN TO ONRAMP ORDERS
-- ============================================================================
-- Adds support for buying a non-USD PLAT stablecoin directly with card via the
-- standalone Transak on-ramp.
--
-- Today, an on-ramp order always credits USDX (because Transak delivers USDC
-- to the treasury). With this migration, the user can pick USDX, EURX,
-- GBPX, or BRLX as the destination token. The webhook handler still credits
-- USDX first; if target_token is set and != 'USDX', it then runs an internal
-- ledger swap from USDX into the chosen token. The swap is gated by
-- target_swap_transaction_id so duplicate webhook deliveries don't double-swap.
--
-- NULL target_token preserves legacy behaviour (USDX credit only), so existing
-- rows and any caller of createOnRampOrder that doesn't set this column are
-- unaffected.
--
-- Run in MySQL CLI:
-- mysql> USE exchange;
-- mysql> SOURCE E:/Web Development/Next/exchange/sql/migrations/021_add_onramp_target_token.sql;

ALTER TABLE onramp_orders
    ADD COLUMN target_token ENUM('USDX', 'EURX', 'GBPX', 'BRLX') NULL AFTER tusd_amount;

ALTER TABLE onramp_orders
    ADD COLUMN target_swap_transaction_id VARCHAR(64) NULL AFTER credit_transaction_id;

-- ============================================================================
-- VERIFY
-- ============================================================================
DESCRIBE onramp_orders;
