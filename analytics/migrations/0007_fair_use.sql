-- Batch 2: fair use on a free, open-signup deployment. Forward-only and additive: the previous
-- release never selects these columns and never writes these tables, so it keeps working.

-- Revenue sent from the browser tracker counts only when the site opts in (anyone can send it).
ALTER TABLE sites ADD COLUMN browser_revenue INTEGER NOT NULL DEFAULT 0;
-- User ids from afsa('identify') may link payments only when the site opts in.
ALTER TABLE sites ADD COLUMN trust_browser_user_id INTEGER NOT NULL DEFAULT 0;

-- Each site's accepted events per UTC day, reported by its Durable Object at most once a minute
-- (absolute and non-decreasing). Summed per account for MAX_EVENTS_PER_ACCOUNT_PER_DAY. Rows of
-- deleted sites stay for the day, so deleting and re-creating a site doesn't reset the account.
CREATE TABLE IF NOT EXISTS usage_daily (
  site_id     TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  day         TEXT NOT NULL,                          -- YYYY-MM-DD, UTC
  events      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
);
CREATE INDEX IF NOT EXISTS usage_daily_account ON usage_daily(account_id, day);

-- The whole deployment's events per UTC day (DAILY_EVENT_BUDGET), grown by each report's delta.
CREATE TABLE IF NOT EXISTS usage_global (
  day         TEXT PRIMARY KEY,
  events      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
