-- Daily USD cap is enforced only from swap_platform_settings.daily_volume_limit_usd (app code).
-- This column is reserved for a possible future per-user override; it must not shadow the platform default.

ALTER TABLE user_swap_settings
  MODIFY COLUMN daily_limit_usd DECIMAL(20, 2) NULL DEFAULT NULL;

-- Clear legacy implicit defaults so nothing in the DB suggests a per-user cap.
UPDATE user_swap_settings SET daily_limit_usd = NULL;
