-- Standard account + API key tables. Every app copies this as its first D1 migration
-- (apps/<app>/migrations/0001_accounts.sql) so @afs/shared/auth works unchanged.
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,           -- acct_xxx
  name        TEXT,
  email       TEXT,                       -- optional, never verified, never required
  created_at  INTEGER NOT NULL            -- unix ms
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,         -- key_xxx
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT,
  prefix        TEXT NOT NULL,            -- first chars of the key, safe to display
  hash          TEXT NOT NULL UNIQUE,     -- sha256(key) hex
  scopes        TEXT NOT NULL DEFAULT '*',-- space-separated; '*' = everything
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys(account_id);
