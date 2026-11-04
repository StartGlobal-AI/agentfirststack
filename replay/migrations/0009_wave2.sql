-- Wave 2: additive only. The previous release never selects these columns or tables, so it keeps
-- working against this schema.

-- consent_source tcf: the IAB TCF v2 purposes that must all have consent (JSON list of purpose ids;
-- NULL = the default [1, 8]: store/access information on a device, measure content performance).
ALTER TABLE sites ADD COLUMN tcf_purposes TEXT;

-- A tags container (ctr_...) on the same account that receives replay signals and survey scores as
-- server events (over the TAGS service binding), and which of them (JSON list; NULL = all).
ALTER TABLE sites ADD COLUMN tags_container_id TEXT;
ALTER TABLE sites ADD COLUMN tags_signals TEXT;

-- Heatmap images rendered with Browser Rendering, per UTC day: per site (scope = site id), per
-- account (scope = account id) and for the deployment (scope = "*"). Counters never go down (a
-- cached image costs nothing and isn't counted). browser_ms = the browser time Cloudflare reported.
-- Rows older than a week are dropped by the cron.
CREATE TABLE IF NOT EXISTS heatmap_image_usage (
  scope       TEXT NOT NULL,
  day         TEXT NOT NULL,                              -- UTC YYYY-MM-DD
  images      INTEGER NOT NULL DEFAULT 0,
  browser_ms  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);
CREATE INDEX IF NOT EXISTS heatmap_image_usage_day ON heatmap_image_usage(day);
