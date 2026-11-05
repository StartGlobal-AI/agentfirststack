-- Emails the platform sends to people (src/email.ts): claims, members, connected apps, project
-- deletion, suspension, setup updates. Every email is queued here once (dedupe_key: one per event
-- and person, so retries and repeated cron runs never send twice), sent at once, and retried by
-- the hourly cron if sending failed. Rows (with their content) are deleted after 30 days, and at
-- once when the person deletes their account.
CREATE TABLE IF NOT EXISTS email_outbox (
  id               TEXT PRIMARY KEY,                -- eml_xxx
  dedupe_key       TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,                   -- project_claimed, member_joined, ...
  category         TEXT NOT NULL CHECK (category IN ('account', 'updates')),
  user_id          TEXT,                            -- the recipient, if a signed-in person
  to_address       TEXT NOT NULL,
  account_id       TEXT,                            -- the project it is about
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
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS email_outbox_user ON email_outbox (user_id, created_at);
CREATE INDEX IF NOT EXISTS email_outbox_created ON email_outbox (created_at);

-- Product updates and setup reminders ('updates' emails) can be turned off; account and security
-- emails ('account') always go out.
ALTER TABLE users ADD COLUMN email_updates INTEGER NOT NULL DEFAULT 1;
