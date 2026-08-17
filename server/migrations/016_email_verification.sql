-- Reference SQL for PAWSMEMORIES_EMAIL_VERIFICATION_SPEC_2026-08-16.md (Phase 1)
-- Applied via MIGRATIONS version 51 in server/migrations/runner.ts and the
-- idempotent users-column path in db.ts.
-- Do NOT run this file directly against production.

-- Email verification tokens. Deliberately a twin of password_resets:
--   * only the SHA-256 hash of the token is persisted, never the raw value
--   * single use, enforced by used_at
--   * expiry enforced in SQL (expires_at > NOW()), not in application code
--   * prior unused rows are invalidated when a new token is issued
--
-- `email` records the address the token was sent to. The token proves control
-- of THAT address, so consuming it must not verify a different one if the
-- account email changed in between. Without this column a user could request a
-- link, change their account email, then click the link and have the new,
-- unproven address marked verified.
CREATE TABLE IF NOT EXISTS email_verifications (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_phone  VARCHAR(32) NOT NULL,          -- internal user key, not a phone number
  email       VARCHAR(190) NOT NULL,         -- address proven by this token
  token_hash  VARCHAR(64) NOT NULL,          -- sha256(raw token)
  expires_at  TIMESTAMP NOT NULL,
  used_at     TIMESTAMP NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_verif_user (user_phone),
  INDEX idx_email_verif_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Entitlement for the free first image. Applied through the requiredColumns
-- list in db.ts, which is the established path for every users column.
-- ALTER TABLE users ADD COLUMN free_image_claimed TINYINT(1) NOT NULL DEFAULT 0;
