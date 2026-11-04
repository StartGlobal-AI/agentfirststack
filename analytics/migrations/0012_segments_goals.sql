-- Wave 1, query power. Forward-only and additive: the previous release never selects these
-- columns or this table.

-- Saved segments: a named filter set (the filter grammar, and/or nested filters_json groups)
-- usable as segment=<id or name> wherever filters are. Idempotent by (site_id, name).
CREATE TABLE IF NOT EXISTS segments (
  id            TEXT PRIMARY KEY,                     -- seg_xxx
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  filters       TEXT,                                 -- grammar string, e.g. country==US;channel!=Direct
  filters_json  TEXT,                                 -- nested and / or / not group (JSON)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS segments_site_name ON segments(site_id, name);

-- Goals: property conditions (JSON {"plan":"pro"}: every key must match) and how they count
-- (every matching event, or once per visit).
ALTER TABLE goals ADD COLUMN props TEXT;
ALTER TABLE goals ADD COLUMN counting TEXT NOT NULL DEFAULT 'every';
