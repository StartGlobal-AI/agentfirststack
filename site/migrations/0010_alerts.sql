-- Alert emails (src/project-health.ts): a site stopped sending analytics data, or a project is
-- close to a fair-use limit. People can turn them off (Account, or the link in one).
ALTER TABLE users ADD COLUMN email_alerts INTEGER NOT NULL DEFAULT 1;

-- The outbox takes the new category: SQLite can't change a CHECK, so the table is rebuilt.
CREATE TABLE email_outbox_next (
  id               TEXT PRIMARY KEY,
  dedupe_key       TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN ('account', 'updates', 'alerts')),
  user_id          TEXT,
  to_address       TEXT NOT NULL,
  account_id       TEXT,
  subject          TEXT NOT NULL,
  text_body        TEXT NOT NULL,
  html_body        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  message_id       TEXT,
  created_at       INTEGER NOT NULL,
  next_attempt_at  INTEGER,
  sent_at          INTEGER
);
INSERT INTO email_outbox_next (id, dedupe_key, kind, category, user_id, to_address, account_id, subject, text_body, html_body,
                               status, attempts, error, message_id, created_at, next_attempt_at, sent_at)
  SELECT id, dedupe_key, kind, category, user_id, to_address, account_id, subject, text_body, html_body,
         status, attempts, error, message_id, created_at, next_attempt_at, sent_at FROM email_outbox;
DROP TABLE email_outbox;
ALTER TABLE email_outbox_next RENAME TO email_outbox;
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS email_outbox_user ON email_outbox (user_id, created_at);
CREATE INDEX IF NOT EXISTS email_outbox_created ON email_outbox (created_at);
CREATE INDEX IF NOT EXISTS email_outbox_to ON email_outbox (to_address, created_at);

-- When each claimed project was last checked, so every run goes round them oldest first.
CREATE TABLE IF NOT EXISTS project_health (
  account_id TEXT PRIMARY KEY,
  usage_checked_at INTEGER,
  quiet_checked_at INTEGER
);

-- Which limits a project's people were warned about: the same warning goes out at most once a week.
-- item: "<service>.<limit>" or "<service>.<limit>:<site, container or inbox id>"; level: near | reached.
CREATE TABLE IF NOT EXISTS limit_warnings (
  account_id TEXT NOT NULL,
  item TEXT NOT NULL,
  level TEXT NOT NULL,
  warned_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, item, level)
);
CREATE INDEX IF NOT EXISTS limit_warnings_warned ON limit_warnings (warned_at);
