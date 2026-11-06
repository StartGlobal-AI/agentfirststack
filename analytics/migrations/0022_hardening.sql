-- Hardening round. Forward-only and additive: the previous release never selects these columns and
-- never writes this table, so it keeps working while the new one rolls out.

-- Server events (POST /v1/sites/:id/events), payments and subscription changes have their own daily
-- budget (MAX_SERVER_EVENTS_PER_SITE_PER_DAY / _PER_ACCOUNT_PER_DAY, DAILY_SERVER_EVENT_BUDGET), so a
-- flood of browser events never refuses them. Reported by each site's Durable Object with `events`.
ALTER TABLE usage_daily ADD COLUMN server_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_global ADD COLUMN server_events INTEGER NOT NULL DEFAULT 0;

-- Where the site's own replay proxy lives (e.g. "/_r"), set by the agent that installed it next to
-- the analytics path proxy (/_a): the tracker then gets the replay loader on that first-party path.
ALTER TABLE sites ADD COLUMN replay_proxy_path TEXT;

-- Per-account daily use of expensive shared work, summed over the account's sites:
--   sql_ms       SQL wall time (MAX_SQL_MS_PER_ACCOUNT_PER_DAY)
--   export_rows  raw rows exported (MAX_EXPORT_ROWS_PER_ACCOUNT_PER_DAY)
-- Counters only go up; rows older than 40 days are deleted by the cron.
CREATE TABLE IF NOT EXISTS account_usage_daily (
  account_id  TEXT NOT NULL,
  day         TEXT NOT NULL,                          -- YYYY-MM-DD, UTC
  kind        TEXT NOT NULL,
  amount      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, day, kind)
);
