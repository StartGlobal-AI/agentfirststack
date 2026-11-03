-- mail: domains, inboxes, threads, messages, attachments, full-text search, webhooks, send counters.
-- All timestamps are unix ms. Blobs (raw MIME, HTML bodies, attachments) live in R2 (BLOBS).

-- Custom domains an account brings. The operator's shared MAIL_DOMAIN is not stored here.
CREATE TABLE IF NOT EXISTS domains (
  id                  TEXT PRIMARY KEY,                 -- dom_xxx
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL UNIQUE,             -- lowercase ASCII (punycode); one owner
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | partial | verified
  receiving_verified  INTEGER NOT NULL DEFAULT 0,
  sending_verified    INTEGER NOT NULL DEFAULT 0,
  catch_all_inbox_id  TEXT,                             -- unknown local parts land here (else rejected)
  records_json        TEXT NOT NULL,                    -- required DNS records (see src/lib/dns.ts)
  last_check_json     TEXT,                             -- last verify result
  checked_at          INTEGER,
  verified_at         INTEGER,
  cf_zone_id          TEXT,                             -- set by auto_configure
  auto_config_json    TEXT,                             -- last auto_configure report
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS domains_account ON domains(account_id);

CREATE TABLE IF NOT EXISTS inboxes (
  id               TEXT PRIMARY KEY,                    -- inb_xxx
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address          TEXT NOT NULL UNIQUE,                -- normalised: lowercase local@domain, no +tag
  username         TEXT NOT NULL,
  domain           TEXT NOT NULL,
  display_name     TEXT,
  expires_at       INTEGER,                             -- from ttl_days; NULL = keep forever
  last_message_at  INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inboxes_account ON inboxes(account_id, created_at);
CREATE INDEX IF NOT EXISTS inboxes_expiry ON inboxes(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS threads (
  id               TEXT PRIMARY KEY,                    -- thr_xxx
  account_id       TEXT NOT NULL,
  inbox_id         TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  subject          TEXT,
  subject_key      TEXT,                                -- normalised subject (no Re:/Fwd:), for header-less replies
  message_count    INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_inbox ON threads(inbox_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS threads_subject ON threads(inbox_id, subject_key);

-- seq is the explicit rowid: the FTS index points at it, and an INTEGER PRIMARY KEY never changes
-- on VACUUM (an implicit rowid can).
CREATE TABLE IF NOT EXISTS messages (
  seq               INTEGER PRIMARY KEY,
  id                TEXT NOT NULL UNIQUE,               -- msg_xxx
  account_id        TEXT NOT NULL,
  inbox_id          TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  thread_id         TEXT NOT NULL,
  direction         TEXT NOT NULL,                      -- in | out
  message_id_header TEXT,                               -- RFC 5322 Message-ID incl. <>
  in_reply_to       TEXT,
  references_header TEXT,
  envelope_from     TEXT,                               -- SMTP MAIL FROM (inbound)
  envelope_to       TEXT,                               -- SMTP RCPT TO as received (keeps +tag)
  from_address      TEXT,
  from_name         TEXT,
  to_json           TEXT NOT NULL DEFAULT '[]',
  cc_json           TEXT NOT NULL DEFAULT '[]',
  bcc_json          TEXT NOT NULL DEFAULT '[]',
  reply_to          TEXT,
  subject           TEXT,
  preview           TEXT,
  text_body         TEXT,                               -- plain text (from text part, else from HTML)
  html_key          TEXT,                               -- R2 key of the HTML body
  html_size         INTEGER,
  raw_key           TEXT,                               -- R2 key of the original MIME (inbound)
  size              INTEGER,
  code              TEXT,                               -- best extracted code (NULL if none)
  verify_link       TEXT,                               -- best verify / magic_login / password_reset link
  codes_json        TEXT NOT NULL DEFAULT '[]',
  links_json        TEXT NOT NULL DEFAULT '[]',
  auth_json         TEXT,
  attachment_count  INTEGER NOT NULL DEFAULT 0,
  read              INTEGER NOT NULL DEFAULT 0,
  status            TEXT,                               -- out: sent | failed
  error             TEXT,                               -- out: provider error when failed
  received_at       INTEGER NOT NULL,                   -- in: arrival time; out: send time
  sent_at           INTEGER                              -- Date header (in) as unix ms, if parseable
);
CREATE INDEX IF NOT EXISTS messages_inbox_time ON messages(inbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_account_time ON messages(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS messages_msgid ON messages(inbox_id, message_id_header);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,                       -- att_xxx
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size          INTEGER NOT NULL,
  content_id    TEXT,
  disposition   TEXT,
  r2_key        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);

-- Full-text search over subject, sender and body. External-content FTS5 kept in sync by triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_name, from_address, text_body,
  content = 'messages', content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_name, from_address, text_body)
  VALUES (new.seq, new.subject, new.from_name, new.from_address, new.text_body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, text_body)
  VALUES ('delete', old.seq, old.subject, old.from_name, old.from_address, old.text_body);
END;

CREATE TABLE IF NOT EXISTS webhooks (
  id                TEXT PRIMARY KEY,                   -- wh_xxx
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  events            TEXT NOT NULL,                      -- space-separated, e.g. "message.received"
  inbox_id          TEXT,                               -- NULL = every inbox of the account
  secret_sealed     TEXT NOT NULL,                      -- encryptSecret() when ENCRYPTION_KEY is set
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_account ON webhooks(account_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                TEXT PRIMARY KEY,                   -- whd_xxx
  webhook_id        TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',    -- pending | delivered | retrying | failed
  attempts          INTEGER NOT NULL DEFAULT 0,
  response_status   INTEGER,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- Per-account, per-UTC-day count of recipients sent to (SEND_DAILY_LIMIT).
CREATE TABLE IF NOT EXISTS send_counters (
  account_id  TEXT NOT NULL,
  day         TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
