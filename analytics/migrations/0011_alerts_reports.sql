-- Wave 1, things that push: alerts, scheduled reports, and where they are delivered. Forward-only
-- and additive: the previous release never selects these tables.

-- Where alerts and reports go. Webhook and Slack URLs are secrets (a Slack incoming-webhook URL
-- is its own credential): sealed with encryptSecret(ENCRYPTION_KEY), never returned; url_hint is
-- a safe label (host and the last 4 characters). Email goes to the project's members only (no
-- address is stored). Natural key: (site_id, url_hash) = sha256 of type + url, or "email".
CREATE TABLE IF NOT EXISTS alert_destinations (
  id                 TEXT PRIMARY KEY,               -- dst_xxx
  site_id            TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,                  -- webhook | slack | email
  name               TEXT,
  url_sealed         TEXT,                           -- NULL for email
  url_hash           TEXT NOT NULL,
  url_hint           TEXT,
  secret_sealed      TEXT,                           -- webhook signing secret (whsec_...)
  last_status        TEXT,                           -- delivered | failed
  last_error         TEXT,
  last_delivered_at  INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_destinations_key ON alert_destinations(site_id, url_hash);

-- Alert rules, evaluated by the cron when due (next_check_at). Idempotent by (site_id, name).
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,                -- alr_xxx
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,                   -- traffic_spike | traffic_drop | no_data | goal | payment
  window_minutes    INTEGER NOT NULL,
  threshold         REAL,
  goal              TEXT,
  filters           TEXT,                            -- the filter grammar (traffic and goal alerts)
  min_visitors      INTEGER,
  cooldown_minutes  INTEGER NOT NULL,
  destination_ids   TEXT NOT NULL,                   -- JSON array of dst_ ids
  enabled           INTEGER NOT NULL DEFAULT 1,
  state             TEXT,                            -- JSON: last check (value, baseline), payment cursor, no-data latch
  next_check_at     INTEGER NOT NULL,
  last_checked_at   INTEGER,
  last_fired_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_site_name ON alerts(site_id, name);
CREATE INDEX IF NOT EXISTS alerts_due ON alerts(enabled, next_check_at);

-- Scheduled digests (weekly / monthly), sent through the same destinations. Idempotent by name.
CREATE TABLE IF NOT EXISTS reports (
  id               TEXT PRIMARY KEY,                 -- rpt_xxx
  site_id          TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  cadence          TEXT NOT NULL,                    -- weekly | monthly
  weekday          INTEGER,                          -- weekly: 1 = Monday ... 7 = Sunday
  day_of_month     INTEGER,                          -- monthly: 1-28
  hour             INTEGER NOT NULL,                 -- 0-23, site timezone
  destination_ids  TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      INTEGER NOT NULL,
  last_sent_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_site_name ON reports(site_id, name);
CREATE INDEX IF NOT EXISTS reports_due ON reports(enabled, next_run_at);

-- Delivery history: every alert firing, report send and test, with per-destination results.
-- Failed deliveries are retried by the cron (next_attempt_at) up to 3 attempts. Purged after 90 days.
CREATE TABLE IF NOT EXISTS alert_events (
  id               TEXT PRIMARY KEY,                 -- aev_xxx
  site_id          TEXT NOT NULL,
  alert_id         TEXT,
  report_id        TEXT,
  kind             TEXT NOT NULL,                    -- alert | report | test
  title            TEXT NOT NULL,
  payload          TEXT NOT NULL,                    -- the JSON body sent to webhooks
  deliveries       TEXT NOT NULL,                    -- JSON [{destination_id, type, status, attempts, error, at}]
  status           TEXT NOT NULL,                    -- delivered | partial | failed | pending | suppressed
  next_attempt_at  INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_events_site ON alert_events(site_id, created_at);
CREATE INDEX IF NOT EXISTS alert_events_alert ON alert_events(alert_id, created_at);
CREATE INDEX IF NOT EXISTS alert_events_retry ON alert_events(status, next_attempt_at);

-- Delivery counters per site and UTC day (MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY,
-- MAX_ALERT_EMAILS_PER_SITE_PER_DAY). They only ever go up.
CREATE TABLE IF NOT EXISTS alert_usage (
  site_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  deliveries  INTEGER NOT NULL DEFAULT 0,
  emails      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day)
);
