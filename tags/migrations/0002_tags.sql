-- tags control plane. Hot per-container state (visitors, event log, dedupe) lives in ContainerDO.
CREATE TABLE IF NOT EXISTS containers (
  id                TEXT PRIMARY KEY,                 -- ctr_xxx
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain            TEXT NOT NULL,                    -- normalised, no scheme/www
  name              TEXT,
  allowed_hostnames TEXT NOT NULL DEFAULT '[]',       -- JSON array of extra hostnames for /collect
  draft             TEXT NOT NULL,                    -- JSON config (validated by zod)
  draft_revision    INTEGER NOT NULL DEFAULT 1,
  draft_updated_at  INTEGER NOT NULL,
  live_version      INTEGER,                          -- NULL until first publish
  published_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS containers_account_domain ON containers(account_id, domain);

-- Immutable published versions.
CREATE TABLE IF NOT EXISTS container_versions (
  container_id  TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  config        TEXT NOT NULL,
  note          TEXT,
  created_by    TEXT,                                 -- api key id
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (container_id, version)
);

CREATE TABLE IF NOT EXISTS preview_tokens (
  token_hash    TEXT PRIMARY KEY,                     -- sha256(token)
  container_id  TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS preview_tokens_container ON preview_tokens(container_id);

-- Server-side destinations. credentials = AES-GCM sealed JSON, never returned.
CREATE TABLE IF NOT EXISTS destinations (
  id            TEXT PRIMARY KEY,                     -- dst_xxx
  container_id  TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT,
  natural_key   TEXT NOT NULL,                        -- e.g. pixel id; same type+key = same destination
  public        TEXT NOT NULL DEFAULT '{}',           -- non-secret credential fields
  credentials   TEXT NOT NULL,
  settings      TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS destinations_container ON destinations(container_id);
CREATE UNIQUE INDEX IF NOT EXISTS destinations_natural ON destinations(container_id, type, natural_key);
