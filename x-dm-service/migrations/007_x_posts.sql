-- Migration 007: x_posts
-- Outbound posts made by the bot, and the record that stops one being made twice.
--
-- A scheduled poster restarts, retries and runs on overlapping timers. Without
-- a durable record of what already went out, each of those is a duplicate on a
-- public timeline -- which is both the most visible failure mode and the one
-- most likely to read as spam to X's automation rules.
--
-- dedupe_key is the unit of "already said this": callers derive it from the
-- content and the campaign, so re-running the same scheduled slot is a no-op
-- while a genuinely new post goes through.
CREATE TABLE IF NOT EXISTS x_posts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dedupe_key VARCHAR(191) UNIQUE NOT NULL,
  campaign VARCHAR(64) NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT NULL,
  -- posted: X accepted it and returned an id.
  -- skipped: deliberately not sent (dry run, disabled, cadence floor).
  -- failed: X rejected it; error_detail says why.
  status ENUM('posted','skipped','failed') NOT NULL,
  x_tweet_id VARCHAR(32) NULL,
  error_detail TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_campaign_created (campaign, created_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
