-- Delivery status, the event feed, allow/block lists, labels, send-only domains and webhook
-- updates. Additive: new tables and columns only; existing rows keep their meaning.

-- 1. Delivery status per recipient, from Cloudflare Email Sending events (a Queues event
--    subscription per sending domain; src/service/delivery.ts). Sent mail is matched by the
--    message id Email Service returned (messages.provider_message_id, backfilled from the stored
--    Message-ID). Rows are bounded by sends (SEND_DAILY_LIMIT) and go with their message.
ALTER TABLE messages ADD COLUMN provider_message_id TEXT;
UPDATE messages SET provider_message_id = trim(message_id_header, '<>')
  WHERE direction = 'out' AND message_id_header IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_provider_id ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deliveries (
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL,
  recipient      TEXT NOT NULL,                         -- lowercase address
  status         TEXT NOT NULL,                         -- sent | delivered | deferred | bounced | failed | rejected | complained
  terminal       INTEGER NOT NULL DEFAULT 0,            -- 1 = no further change expected (complained may still follow delivered)
  internal       INTEGER NOT NULL DEFAULT 0,            -- 1 = delivered inside the Worker to one of the account's inboxes
  smtp_code      TEXT,
  smtp_enhanced  TEXT,
  smtp_response  TEXT,                                  -- capped at 500 characters
  detail         TEXT,                                  -- bounce / rejection / failure reason or complaint type
  event_id       TEXT,                                  -- last Email Sending event applied (dedupe)
  event_at       INTEGER,                               -- its eventTimestamp (unix ms), for ordering
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient)
);
CREATE INDEX IF NOT EXISTS deliveries_account ON deliveries(account_id, updated_at);

-- 2. Event feed (GET /v1/events): the same events webhooks get, for agents without a public URL.
--    Kept 7 days (cron), at most MAX_FEED_EVENTS_PER_DAY per account per UTC day (account_daily 'event').
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,                      -- the cursor (next_after)
  id          TEXT NOT NULL UNIQUE,                     -- evt_xxx, as in the webhook delivery
  account_id  TEXT NOT NULL,
  inbox_id    TEXT,
  type        TEXT NOT NULL,
  data_json   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_account ON events(account_id, seq);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);

-- 3. Allow / block lists. receive: matched against the authenticated sender and refused at SMTP
--    time; send: block only. Account-wide (inbox_id NULL) or for one inbox.
--    MAX_LIST_ENTRIES_PER_ACCOUNT caps them (default 100).
CREATE TABLE IF NOT EXISTS list_entries (
  id          TEXT PRIMARY KEY,                         -- lst_xxx
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  inbox_id    TEXT,                                     -- NULL = every inbox of the account
  direction   TEXT NOT NULL,                            -- receive | send
  kind        TEXT NOT NULL,                            -- allow | block
  entry       TEXT NOT NULL,                            -- lowercase address or domain
  entry_type  TEXT NOT NULL,                            -- address | domain (a domain covers its subdomains)
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS list_entries_unique ON list_entries(account_id, direction, kind, entry, COALESCE(inbox_id, ''));
CREATE INDEX IF NOT EXISTS list_entries_lookup ON list_entries(account_id, direction);

-- 4. Labels: JSON arrays of [a-z0-9:_-]{1,64}, at most 20 per message or thread. NULL = none.
--    Account-wide thread lists need an index by account.
ALTER TABLE messages ADD COLUMN labels_json TEXT;
ALTER TABLE threads ADD COLUMN labels_json TEXT;
CREATE INDEX IF NOT EXISTS threads_account ON threads(account_id, last_message_at DESC);

-- 5. Send-only custom domains (receiving: false): no receiving records, no inbound mail, status
--    "verified" once ownership and sending pass. Existing domains receive, as before.
ALTER TABLE domains ADD COLUMN receiving_enabled INTEGER NOT NULL DEFAULT 1;

-- 6. Webhooks: several inboxes, custom headers (sealed with ENCRYPTION_KEY, names kept for
--    display), last change.
ALTER TABLE webhooks ADD COLUMN inbox_ids_json TEXT;           -- sorted JSON array; NULL = inbox_id (or every inbox)
ALTER TABLE webhooks ADD COLUMN headers_sealed TEXT;           -- encryptSecret(JSON {name: value}); NULL = none
ALTER TABLE webhooks ADD COLUMN header_names TEXT;             -- space-separated names, shown in responses
ALTER TABLE webhooks ADD COLUMN updated_at INTEGER;
