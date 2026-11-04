-- GTM parity: environments, previewing a version, and the enrichment lookup store. Forward-only and
-- additive: the previous release never reads these tables or the new column, so it keeps working.

-- Environments: a named snippet (/c/:id.js?env=<token>) pinned to a version, or to the draft
-- (version NULL). The token is derived from ENCRYPTION_KEY, the id and nonce, so it can be shown
-- again; reauthorize rotates the nonce. Pinned versions are never pruned by publish.
CREATE TABLE IF NOT EXISTS environments (
  id            TEXT PRIMARY KEY,                     -- env_xxx
  container_id  TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       INTEGER,                              -- NULL = the draft
  nonce         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                        -- sha256(token)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS environments_name ON environments(container_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS environments_token ON environments(token_hash);

-- A preview link can show a published version instead of the draft.
ALTER TABLE preview_tokens ADD COLUMN version INTEGER;

-- Lookup tables for server-side enrichment (destinations' settings.params.set { lookup, key }),
-- e.g. SKU -> margin. Never sent to browsers. rows = JSON object { key: value }.
CREATE TABLE IF NOT EXISTS lookups (
  container_id  TEXT NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  rows          TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  bytes         INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (container_id, name)
);
