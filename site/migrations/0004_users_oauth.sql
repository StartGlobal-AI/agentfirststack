-- People (optional): Google sign-in, project memberships, sessions, claim links, and the OAuth 2.1
-- authorization server for MCP connectors. See docs/accounts.md. Every token, code and session
-- is stored as its SHA-256 only.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,                 -- usr_xxx
  google_sub     TEXT NOT NULL UNIQUE,             -- Google's stable subject id ("dev:<email>" for DEV_MODE logins)
  email          TEXT NOT NULL,
  name           TEXT,
  picture        TEXT,                             -- URL from Google; never fetched by us
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

-- A user's access to a project (an account). The first claimer is the owner.
CREATE TABLE IF NOT EXISTS memberships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS memberships_account ON memberships(account_id);

-- Browser sessions (cookie afs_session). 30 days, sliding.
CREATE TABLE IF NOT EXISTS sessions (
  hash          TEXT PRIMARY KEY,                  -- sha256(cookie value)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

-- Single-use links that add the person who opens them to a project. 7 days.
CREATE TABLE IF NOT EXISTS claim_links (
  hash                TEXT PRIMARY KEY,            -- sha256(token)
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by_key_id   TEXT,                        -- the API key that asked for it (agents)
  created_by_user_id  TEXT,                        -- or the member who invited from the dashboard
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  used_at             INTEGER,
  used_by_user_id     TEXT
);
CREATE INDEX IF NOT EXISTS claim_links_account ON claim_links(account_id);
CREATE INDEX IF NOT EXISTS claim_links_expires ON claim_links(expires_at);

-- Dynamically registered public OAuth clients (RFC 7591). Identical registrations share a row.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id             TEXT PRIMARY KEY,                 -- client_id
  name           TEXT NOT NULL,
  redirect_uris  TEXT NOT NULL,                    -- JSON array, matched exactly
  client_uri     TEXT,
  metadata_hash  TEXT NOT NULL UNIQUE,             -- sha256 of name + redirect_uris, for idempotent registration
  ip_hash        TEXT,                             -- truncated sha256 of the registering network (rate limit)
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_clients_ip ON oauth_clients(ip_hash, created_at);

-- A user's consent for a client to use one project with one scope ("connected apps").
CREATE TABLE IF NOT EXISTS oauth_grants (
  id            TEXT PRIMARY KEY,                  -- grant_xxx
  client_id     TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,                     -- '*' or 'read'
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX IF NOT EXISTS oauth_grants_account ON oauth_grants(account_id);

-- Authorization codes: single use, 10 minutes, bound to client, redirect_uri and PKCE challenge.
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash            TEXT PRIMARY KEY,                -- sha256(code)
  grant_id        TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,                   -- S256
  resource        TEXT,                            -- RFC 8707 resource indicator, if sent
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_codes_expires ON oauth_codes(expires_at);

-- Refresh tokens: 30 days, rotated on every use. Presenting a rotated one revokes the grant.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  hash        TEXT PRIMARY KEY,                    -- sha256(token)
  grant_id    TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  rotated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_refresh_grant ON oauth_refresh_tokens(grant_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_expires ON oauth_refresh_tokens(expires_at);
