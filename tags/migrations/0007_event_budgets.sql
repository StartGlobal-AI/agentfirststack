-- Daily event budgets across containers: per account (MAX_EVENTS_PER_ACCOUNT_PER_DAY) and for the
-- whole deployment (MAX_EVENTS_PER_DAY). Forward-only and additive: the previous release never
-- reads or writes these tables, so it keeps working.

-- Each container's accepted browser hits and backend events per UTC day, reported by its Durable
-- Object at most once a minute (absolute and non-decreasing). Summed per account for
-- MAX_EVENTS_PER_ACCOUNT_PER_DAY. Rows of deleted containers stay for the day, so deleting and
-- re-creating a container doesn't reset the account.
CREATE TABLE IF NOT EXISTS usage_daily (
  container_id    TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  day             TEXT NOT NULL,                        -- YYYY-MM-DD (UTC)
  browser_events  INTEGER NOT NULL DEFAULT 0,
  server_events   INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (container_id, day)
);
CREATE INDEX IF NOT EXISTS usage_daily_account ON usage_daily(account_id, day);

-- The whole deployment's events per UTC day (MAX_EVENTS_PER_DAY), grown by each report's delta.
CREATE TABLE IF NOT EXISTS usage_global (
  day             TEXT PRIMARY KEY,
  browser_events  INTEGER NOT NULL DEFAULT 0,
  server_events   INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
