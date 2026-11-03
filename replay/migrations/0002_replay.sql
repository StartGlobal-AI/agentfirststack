-- Control plane for replay. Recordings live in R2 and each site's Durable Object, never here.
CREATE TABLE IF NOT EXISTS sites (
  id                     TEXT PRIMARY KEY,                -- rsite_xxx
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain                 TEXT NOT NULL,                   -- normalised: lowercase, no scheme/path/port/www.
  name                   TEXT,
  enabled                INTEGER NOT NULL DEFAULT 1,      -- 0 = the loader records nothing
  sample_rate            REAL NOT NULL DEFAULT 1,         -- 0..1, share of browser sessions recorded
  mask_mode              TEXT NOT NULL DEFAULT 'strict',  -- strict | balanced | relaxed
  unmask_selectors       TEXT NOT NULL DEFAULT '[]',      -- JSON arrays of CSS selectors
  mask_selectors         TEXT NOT NULL DEFAULT '[]',
  block_selectors        TEXT NOT NULL DEFAULT '[]',
  exclude_paths          TEXT NOT NULL DEFAULT '[]',      -- JSON array of path globs not recorded
  allowed_hostnames      TEXT,                            -- JSON array; NULL = the domain and its subdomains
  max_session_minutes    INTEGER NOT NULL DEFAULT 30,
  retention_days         INTEGER NOT NULL DEFAULT 30,     -- recordings, sessions, signals
  heatmap_retention_days INTEGER NOT NULL DEFAULT 180,    -- daily click/scroll aggregates
  capture_console_errors INTEGER NOT NULL DEFAULT 1,
  require_consent        INTEGER NOT NULL DEFAULT 0,      -- 1 = wait for afsr('consent', true)
  analytics_site_id      TEXT,                            -- linked analytics site (signals forwarded there)
  purged_at              INTEGER,                         -- last hourly purge of this site's DO + R2
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_account_domain ON sites(account_id, domain);
CREATE INDEX IF NOT EXISTS sites_purged ON sites(purged_at);

-- Expiring links to the human player. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS replay_links (
  id          TEXT PRIMARY KEY,                           -- rpl_xxx
  token_hash  TEXT NOT NULL UNIQUE,                       -- sha256(rpt_...) hex
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  last_viewed_at INTEGER,
  views       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS replay_links_site ON replay_links(site_id, session_id);
CREATE INDEX IF NOT EXISTS replay_links_expiry ON replay_links(expires_at);

-- R2 prefixes still to delete (a deleted site's chunks), finished by the hourly cron in batches.
CREATE TABLE IF NOT EXISTS r2_cleanup (
  prefix      TEXT PRIMARY KEY,                           -- e.g. "rsite_xxx/"
  created_at  INTEGER NOT NULL
);
