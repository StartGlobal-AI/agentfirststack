-- Per-IP signup log for SIGNUP_HOURLY_LIMIT. Lives next to accounts/api_keys (the identity DB).
-- Rows older than a day are pruned on each signup.
CREATE TABLE IF NOT EXISTS signup_log (
  ip_hash     TEXT NOT NULL,     -- truncated sha256 of the client IP; never the IP itself
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_log_ip ON signup_log(ip_hash, created_at);
