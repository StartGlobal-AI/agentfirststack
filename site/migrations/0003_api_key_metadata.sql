-- API keys can expire (OAuth access tokens, 8 hours) and record where they came from.
-- authenticate() rejects a key whose expires_at has passed; the site's daily cron deletes them.
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;          -- unix ms; NULL = never expires
ALTER TABLE api_keys ADD COLUMN oauth_grant_id TEXT;         -- set on OAuth access tokens (oauth_grants.id)
ALTER TABLE api_keys ADD COLUMN created_by_user_id TEXT;     -- set on keys made in the dashboard (users.id)
CREATE INDEX IF NOT EXISTS api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_keys_grant ON api_keys(oauth_grant_id) WHERE oauth_grant_id IS NOT NULL;
