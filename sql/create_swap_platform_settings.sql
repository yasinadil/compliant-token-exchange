-- Configurable platform-wide swap settings (managed via admin panel)
-- Stores key-value pairs for rate limits, daily volume limits, etc.

CREATE TABLE IF NOT EXISTS swap_platform_settings (
  setting_key   VARCHAR(100)  PRIMARY KEY,
  setting_value VARCHAR(255)  NOT NULL,
  description   VARCHAR(500)  NULL,
  updated_by    VARCHAR(100)  NULL,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default settings
INSERT INTO swap_platform_settings (setting_key, setting_value, description) VALUES
  ('max_trades_per_day',      '20',    'Maximum number of fiat swap trades a user can make per day'),
  ('daily_volume_limit_usd',  '10000', 'Maximum daily swap volume per user in USD'),
  ('approval_threshold_usd',  '5000',  'Swap USD value at or above which admin approval is required'),
  ('kyc_required',            'true',  'Whether KYC verification is required to use fiat swaps'),
  ('kyc_required_trade',      'true',  'Whether KYC verification is required to use AMM trading')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

