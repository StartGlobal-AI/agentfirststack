-- Abuse and cost controls for the free hosted service (see README "Fair use").

-- 1. Concurrent waits. A wait that has to park takes a slot here until it returns (or its
--    expires_at passes, if the Worker died). One INSERT ... WHERE count < cap acquires a slot
--    atomically, so MAX_CONCURRENT_WAITS (per account) and MAX_CONCURRENT_WAITS_PER_INBOX hold.
--    Expired rows are ignored and pruned by the cron.
CREATE TABLE IF NOT EXISTS active_waits (
  id          TEXT PRIMARY KEY,                         -- wait_xxx
  account_id  TEXT NOT NULL,
  inbox_id    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL                          -- unix ms: the wait's deadline plus a margin
);
CREATE INDEX IF NOT EXISTS active_waits_account ON active_waits(account_id, expires_at);
CREATE INDEX IF NOT EXISTS active_waits_inbox ON active_waits(inbox_id, expires_at);
CREATE INDEX IF NOT EXISTS active_waits_expiry ON active_waits(expires_at);

-- 2. Who sent a message, as a key that one party cannot multiply cheaply: the registrable domain
--    of the authenticated sender, or the full address on shared mailbox providers (gmail.com, the
--    shared MAIL_DOMAIN, ...). See src/lib/sender.ts. Used for per-sender daily caps and to pick
--    what a full inbox evicts. Existing rows get the From domain (close enough; they age out).
ALTER TABLE messages ADD COLUMN sender_key TEXT;
UPDATE messages SET sender_key = lower(substr(from_address, instr(from_address, '@') + 1))
  WHERE direction = 'in' AND from_address IS NOT NULL AND instr(from_address, '@') > 0;
CREATE INDEX IF NOT EXISTS messages_inbox_sender ON messages(inbox_id, sender_key, received_at);

-- 3. Mailing-list, bulk and auto-generated mail (List-Id, List-Unsubscribe, Precedence: bulk,
--    Auto-Submitted, bounces). It never unlocks SHARED_SEND_POLICY=reply_only.
ALTER TABLE messages ADD COLUMN automated INTEGER NOT NULL DEFAULT 0;

-- 4. Attachments beyond the per-message cap are kept only in the raw MIME.
ALTER TABLE messages ADD COLUMN attachments_omitted INTEGER NOT NULL DEFAULT 0;

-- 5. Inbound messages per inbox, per sender key, per UTC day (MAX_INBOUND_PER_SENDER_PER_DAY).
--    Rows older than a week are pruned by the cron.
CREATE TABLE IF NOT EXISTS sender_counters (
  inbox_id    TEXT NOT NULL,
  sender      TEXT NOT NULL,
  day         TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  account_id  TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (inbox_id, sender, day)
);
CREATE INDEX IF NOT EXISTS sender_counters_account ON sender_counters(account_id, sender, day);
CREATE INDEX IF NOT EXISTS sender_counters_day ON sender_counters(day);

-- 6. Other per-account daily budgets, by kind: inbox_create, inbox_delete, webhook_test.
CREATE TABLE IF NOT EXISTS account_daily (
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  day         TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, kind, day)
);
CREATE INDEX IF NOT EXISTS account_daily_day ON account_daily(day);

-- 7. Stored text per account (UTF-8 bytes of text_body + links_json, which the FTS index mirrors),
--    kept by triggers, for MAX_TEXT_BYTES_PER_ACCOUNT. Over budget, new mail keeps only a short
--    excerpt in D1 (the raw MIME in R2 keeps everything).
CREATE TABLE IF NOT EXISTS account_usage (
  account_id  TEXT PRIMARY KEY,
  text_bytes  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO account_usage (account_id, text_bytes)
  SELECT account_id, SUM(COALESCE(length(CAST(text_body AS BLOB)), 0) + COALESCE(length(CAST(links_json AS BLOB)), 0))
  FROM messages GROUP BY account_id;
CREATE TRIGGER IF NOT EXISTS messages_usage_ai AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO account_usage (account_id, text_bytes) VALUES (new.account_id, 0);
  UPDATE account_usage
    SET text_bytes = text_bytes + COALESCE(length(CAST(new.text_body AS BLOB)), 0) + COALESCE(length(CAST(new.links_json AS BLOB)), 0)
    WHERE account_id = new.account_id;
END;
CREATE TRIGGER IF NOT EXISTS messages_usage_ad AFTER DELETE ON messages BEGIN
  UPDATE account_usage
    SET text_bytes = MAX(text_bytes - COALESCE(length(CAST(old.text_body AS BLOB)), 0) - COALESCE(length(CAST(old.links_json AS BLOB)), 0), 0)
    WHERE account_id = old.account_id;
END;

-- 8. Webhook delivery logs are purged after 7 days by the cron.
CREATE INDEX IF NOT EXISTS webhook_deliveries_created ON webhook_deliveries(created_at);

-- 9. Address tombstones expire (ADDRESS_TOMBSTONE_DAYS, default 90) and are only written for
--    addresses that received mail; the cron prunes expired ones by deleted_at.
CREATE INDEX IF NOT EXISTS address_tombstones_deleted ON address_tombstones(deleted_at);

-- 10. Small key/value state for the cron (the R2 orphan sweep's list cursor).
CREATE TABLE IF NOT EXISTS cron_state (
  name        TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL
);
