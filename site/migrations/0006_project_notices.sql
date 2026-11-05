-- What a project's agent has seen of the setup check, and the notice that tells it about new
-- setup items (src/setup-catalog.ts, src/notices.ts).
--
-- setup_state: written each time the project's agent runs the setup check (GET /v1/setup,
-- afs_check_setup): when, which catalog version it saw, and which check ids it was shown.
CREATE TABLE IF NOT EXISTS setup_state (
  account_id       TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  checked_at       INTEGER NOT NULL,
  catalog_version  INTEGER NOT NULL,
  seen             TEXT NOT NULL DEFAULT '[]'   -- JSON array of check ids
);

-- project_notices: one pending notice per project, written by the site's daily cron when the
-- setup catalog has items the project's agent hasn't seen, deleted when it runs the check. Every
-- service reads it (@afs/shared notices) and adds it to an API or MCP answer at most once a day;
-- the analytics weekly report shows owner_notice to people.
CREATE TABLE IF NOT EXISTS project_notices (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  notice       TEXT NOT NULL,
  owner_notice TEXT,
  created_at   INTEGER NOT NULL,
  shown_at     INTEGER
);
