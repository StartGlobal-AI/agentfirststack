-- Wave 2 security review.
-- Crawler hits per site and day across an account, and for the whole deployment, so
-- MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY and MAX_CRAWL_HITS_PER_DAY can hold.
CREATE TABLE IF NOT EXISTS crawl_usage_daily (
  site_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
);
CREATE INDEX IF NOT EXISTS crawl_usage_daily_account ON crawl_usage_daily(account_id, day);
CREATE TABLE IF NOT EXISTS crawl_usage_global (day TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);

-- Failed webhook signatures per integration in a 10-minute window (Polar, Paddle, LemonSqueezy):
-- past the limit the provider route answers 429 until the window ends.
ALTER TABLE integrations ADD COLUMN sig_fail_window INTEGER;
ALTER TABLE integrations ADD COLUMN sig_fail_count INTEGER NOT NULL DEFAULT 0;

-- Failed share-link passwords: per (link, hashed IP) in 15-minute windows and per link per hour.
-- key = a salted hash; the IP is never stored.
CREATE TABLE IF NOT EXISTS share_attempts (
  key TEXT PRIMARY KEY,
  win INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_attempts_expires ON share_attempts(expires_at);

-- Browser-sent user properties (afsa('identify', id, props)) are opt-in per site, like browser revenue.
ALTER TABLE sites ADD COLUMN browser_user_props INTEGER NOT NULL DEFAULT 0;
