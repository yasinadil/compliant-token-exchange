-- SQL Migration: Add security and admin control tables
-- Run this against your MySQL database (exchange)

-- User swap settings and controls
CREATE TABLE IF NOT EXISTS user_swap_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    is_swap_paused BOOLEAN DEFAULT FALSE,
    pause_reason TEXT,
    paused_by VARCHAR(255),
    paused_at TIMESTAMP NULL,
    daily_limit_usd DECIMAL(20, 2) NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_paused (is_swap_paused)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pending approvals for large transactions
CREATE TABLE IF NOT EXISTS pending_swap_approvals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    approval_id VARCHAR(64) NOT NULL UNIQUE,
    user_id VARCHAR(255) NOT NULL,
    
    -- Swap details
    from_token VARCHAR(10) NOT NULL,
    from_amount DECIMAL(36, 18) NOT NULL,
    to_token VARCHAR(10) NOT NULL,
    estimated_to_amount DECIMAL(36, 18) NOT NULL,
    usd_value DECIMAL(20, 2) NOT NULL,
    
    -- Rate at time of request
    from_usd_rate DECIMAL(36, 18) NOT NULL,
    to_usd_rate DECIMAL(36, 18) NOT NULL,
    
    -- Status
    status ENUM('pending', 'approved', 'rejected', 'expired', 'executed') NOT NULL DEFAULT 'pending',
    
    -- Admin action
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    
    -- Execution reference
    executed_swap_id INT,
    
    -- Metadata
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_expires_at (expires_at),
    
    FOREIGN KEY (executed_swap_id) REFERENCES swap_transactions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limiting tracking (recent swaps per user)
CREATE TABLE IF NOT EXISTS swap_rate_limits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    swap_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_timestamp (user_id, swap_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Daily swap totals (for $10K daily limit tracking)
CREATE TABLE IF NOT EXISTS daily_swap_totals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    swap_date DATE NOT NULL,
    total_usd_value DECIMAL(20, 2) NOT NULL DEFAULT 0,
    swap_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY unique_user_date (user_id, swap_date),
    INDEX idx_user_id (user_id),
    INDEX idx_date (swap_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: Admin roles are determined by the auth API (the identity provider/api/Auth)
-- The Roles array in the auth response contains "Admin" for admin users
-- No separate admin_users table is needed

-- Admin action audit log
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    admin_user_id VARCHAR(255) NOT NULL,
    action_type ENUM('approve_swap', 'reject_swap', 'pause_user', 'unpause_user', 'add_admin', 'remove_admin', 'adjust_limit') NOT NULL,
    target_user_id VARCHAR(255),
    target_approval_id VARCHAR(64),
    details JSON,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_admin (admin_user_id),
    INDEX idx_action (action_type),
    INDEX idx_target_user (target_user_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cleanup old rate limit entries (run periodically)
-- DELETE FROM swap_rate_limits WHERE swap_timestamp < DATE_SUB(NOW(), INTERVAL 5 MINUTE);

