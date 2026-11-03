-- Control plane for analytics. Raw events live in the per-site Durable Object, never here.
CREATE TABLE IF NOT EXISTS sites (
  id                TEXT PRIMARY KEY,                 -- site_xxx
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain            TEXT NOT NULL,                    -- normalised: lowercase, no scheme/path/port/www.
  name              TEXT,
  timezone          TEXT NOT NULL DEFAULT 'UTC',      -- IANA name; periods and buckets use it
  visitor_id_mode   TEXT NOT NULL DEFAULT 'cookieless', -- cookieless | persistent
  retention_days    INTEGER NOT NULL DEFAULT 400,
  allowed_hostnames TEXT,                             -- JSON array; NULL = accept any hostname
  respect_dnt       INTEGER NOT NULL DEFAULT 0,       -- 1 = drop events with GPC / DNT set
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_account_domain ON sites(account_id, domain);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,                       -- goal_xxx
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                          -- event | pageview
  match       TEXT NOT NULL,                          -- event name, or path pattern with * wildcards
  value       REAL,                                   -- revenue per conversion when the event carries none
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS goals_site_name ON goals(site_id, name);

CREATE TABLE IF NOT EXISTS share_links (
  token       TEXT PRIMARY KEY,                       -- shr_xxx, appears in the public URL
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_site ON share_links(site_id);
