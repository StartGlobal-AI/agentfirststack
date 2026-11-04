-- Parity release (docs/parity/replay.md): additive only. The previous release never selects these
-- columns or tables, so it keeps working against this schema.

-- afsr('identify') ids hashed in the browser (SHA-256 with the site id as salt) before they leave it.
ALTER TABLE sites ADD COLUMN hash_user_ids INTEGER NOT NULL DEFAULT 0;

-- Saved segments: named session filter sets per site (segment_id= on every read).
CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,                           -- seg_xxx
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  filters     TEXT NOT NULL,                              -- JSON: the session filters
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS segments_site_name ON segments(site_id, name);

-- Failed fetch/XHR requests (method, scrubbed path, status, duration; never headers or bodies).
ALTER TABLE sites ADD COLUMN capture_network_errors INTEGER NOT NULL DEFAULT 0;
-- console.warn as errors of kind console_warn (opt-in).
ALTER TABLE sites ADD COLUMN capture_console_warnings INTEGER NOT NULL DEFAULT 0;

-- On-site surveys and feedback (popover, embedded, feedback tab). The definition (questions,
-- targeting, trigger, frequency, limits, appearance, link_session, ...) is one JSON column;
-- responses live in the site's Durable Object. Natural key: (site_id, name).
CREATE TABLE IF NOT EXISTS surveys (
  id            TEXT PRIMARY KEY,                         -- rsv_xxx
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,                            -- popover | embedded | feedback
  status        TEXT NOT NULL DEFAULT 'draft',            -- draft | active | paused | closed
  version       INTEGER NOT NULL DEFAULT 1,               -- bumped when the questions change
  definition    TEXT NOT NULL,
  closed_reason TEXT,                                     -- max_responses | ends_at | NULL
  preview_token TEXT,                                     -- test_survey's preview token (allows test responses only)
  preview_expires_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS surveys_site_name ON surveys(site_id, name);
CREATE INDEX IF NOT EXISTS surveys_site_status ON surveys(site_id, status);
-- Changes whenever the site's active surveys change (the loader loads /sv/<site>.<rev>.js); NULL = none.
ALTER TABLE sites ADD COLUMN surveys_rev TEXT;

-- Clips: a share link can play a window of its session (and carry a note).
ALTER TABLE replay_links ADD COLUMN start_ms INTEGER;
ALTER TABLE replay_links ADD COLUMN end_ms INTEGER;
ALTER TABLE replay_links ADD COLUMN note TEXT;

-- Consent and exclusion. require_consent: 0 no, 1 everywhere, 2 only for EEA, UK and CH visitors
-- (Cloudflare's country). consent_source: api (afsr('consent')) | gcm (Google Consent Mode
-- analytics_storage). exclude_ip_ranges: JSON list of CIDRs refused at ingest (never stored).
ALTER TABLE sites ADD COLUMN consent_source TEXT NOT NULL DEFAULT 'api';
ALTER TABLE sites ADD COLUMN exclude_ip_ranges TEXT;

-- Signed webhooks (the mail app's pattern): per account, optionally one site (and a segment for
-- segment.session). The secret is sealed with ENCRYPTION_KEY and shown once. Deliveries are
-- retried with backoff by the site's Durable Object alarm and kept 7 days.
CREATE TABLE IF NOT EXISTS webhooks (
  id            TEXT PRIMARY KEY,                         -- wh_xxx
  account_id    TEXT NOT NULL,
  site_id       TEXT,                                     -- NULL = every site of the account
  segment_id    TEXT,                                     -- segment.session: this segment
  url           TEXT NOT NULL,
  events        TEXT NOT NULL,                            -- space-separated event types
  secret_sealed TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_account ON webhooks(account_id);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,                       -- whd_xxx
  webhook_id      TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  site_id         TEXT,
  event_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL,                          -- pending | sending | retrying | delivered | failed | dropped
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_at         INTEGER NOT NULL,
  response_status INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(site_id, status, next_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created ON webhook_deliveries(created_at);
-- Deliveries and tests per account per UTC day (MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY, MAX_WEBHOOK_TESTS_PER_DAY).
CREATE TABLE IF NOT EXISTS webhook_usage (
  account_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  deliveries  INTEGER NOT NULL DEFAULT 0,
  tests       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

-- Event definitions after the fact: a click (selector contains / label / link target) and/or a page
-- visit, usable as event=<name> and funnel step event:<name> over everything already recorded.
CREATE TABLE IF NOT EXISTS event_definitions (
  id          TEXT PRIMARY KEY,                           -- evd_xxx
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  match       TEXT NOT NULL,                              -- JSON {click?: {selector_contains?, label?, href_contains?}, page?}
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_definitions_site_name ON event_definitions(site_id, name);
-- Automatic events in the recorder: form_submit (outbound_click and download are derived from clicks).
ALTER TABLE sites ADD COLUMN auto_events INTEGER NOT NULL DEFAULT 1;

-- Zones for heatmaps: CSS selectors of page areas (the recorder tags each click with the first that
-- contains it, else a landmark: header, nav, main, footer, aside, form, section[id], dialog).
ALTER TABLE sites ADD COLUMN zones TEXT NOT NULL DEFAULT '[]';
