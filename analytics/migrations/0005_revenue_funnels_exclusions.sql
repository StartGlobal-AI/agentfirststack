-- Batch 1: revenue attribution, saved funnels, ingest exclusions, scroll goals.
-- Forward-only and additive: the previous release never selects these columns and never writes
-- these tables, so it keeps working against this schema.

-- Ingest exclusions: JSON {"ips":[],"paths":[],"hostnames":[],"countries":[]}; NULL = none.
ALTER TABLE sites ADD COLUMN exclusions TEXT;

-- Scroll goals: the max scroll % a pageview of the matching path must reach (1-100).
ALTER TABLE goals ADD COLUMN threshold INTEGER;

-- Saved funnels (steps as a JSON array of "/path", "event:x", "goal:Name"); idempotent by name.
CREATE TABLE IF NOT EXISTS funnels (
  id          TEXT PRIMARY KEY,                       -- fnl_xxx
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  steps       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS funnels_site_name ON funnels(site_id, name);

-- Payment provider integrations (Stripe). The webhook signing secret is sealed with
-- encryptSecret(ENCRYPTION_KEY) and never returned. Delivery status lives next to it.
CREATE TABLE IF NOT EXISTS integrations (
  id                   TEXT PRIMARY KEY,              -- int_xxx
  site_id              TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,                 -- stripe
  secret_sealed        TEXT NOT NULL,
  options              TEXT,                          -- JSON {"record_test_events": false}
  events_received      INTEGER NOT NULL DEFAULT 0,
  last_event_at        INTEGER,
  last_event_type      TEXT,
  last_event_livemode  INTEGER,
  last_result          TEXT,                          -- recorded | ignored: <reason> | duplicate
  last_error           TEXT,
  last_error_at        INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS integrations_site_provider ON integrations(site_id, provider);
