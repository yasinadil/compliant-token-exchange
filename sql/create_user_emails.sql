-- user_emails: denormalised user_id -> email lookup for the Admin Panel
-- transactions feed. Populated at login/registration from the external auth
-- service. The app also creates this table lazily at runtime
-- (see app/lib/user-email-service.ts), so running this is optional but
-- recommended for explicit provisioning.

CREATE TABLE IF NOT EXISTS user_emails (
    user_id    VARCHAR(255) NOT NULL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
               ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
