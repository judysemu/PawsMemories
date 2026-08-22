-- Migration 008: record the scope a token was granted.
--
-- X fixes scopes at issue time. The granted scope came back in the token
-- response and was passed around but never stored, so there was no way to ask
-- what a stored token could actually do -- which is how a token minted without
-- tweet.write sat in place looking healthy while every post would have
-- returned 403.
--
-- NULL means "issued before this column existed", which is not the same as
-- "cannot post". Callers must treat it as unknown rather than as a denial.
ALTER TABLE x_oauth_tokens
  ADD COLUMN granted_scope TEXT NULL AFTER refresh_token;
