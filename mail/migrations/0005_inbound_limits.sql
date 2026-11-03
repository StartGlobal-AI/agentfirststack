-- Inbound storage limits and race-free Message-ID dedupe.
--   - messages.text_truncated: text_body is capped in D1 (the raw MIME in R2 keeps everything).
--   - inboxes.inbound_count: inbound messages an inbox holds, kept by triggers, so the email()
--     handler can enforce MAX_MESSAGES_PER_INBOX with one row read.
--   - inbound_counters: inbound messages per account per UTC day (MAX_INBOUND_PER_ACCOUNT_PER_DAY).
--   - a partial unique index on (inbox_id, message_id_header) for inbound mail, so two concurrent
--     deliveries of the same message cannot both be stored (ingest inserts with ON CONFLICT DO NOTHING).

-- 1. Remove inbound duplicates the old check-then-insert could create (keep the oldest copy),
--    fix their threads' counts, then enforce uniqueness. R2 blobs of removed copies stay under the
--    inbox prefix and go when the inbox is deleted.
UPDATE threads SET message_count = message_count - (
  SELECT COUNT(*) FROM messages m
  WHERE m.thread_id = threads.id AND m.direction = 'in' AND m.message_id_header IS NOT NULL
    AND m.seq NOT IN (SELECT MIN(seq) FROM messages WHERE direction = 'in' AND message_id_header IS NOT NULL GROUP BY inbox_id, message_id_header)
)
WHERE id IN (
  SELECT thread_id FROM messages
  WHERE direction = 'in' AND message_id_header IS NOT NULL
    AND seq NOT IN (SELECT MIN(seq) FROM messages WHERE direction = 'in' AND message_id_header IS NOT NULL GROUP BY inbox_id, message_id_header)
);
DELETE FROM attachments WHERE message_id IN (
  SELECT id FROM messages
  WHERE direction = 'in' AND message_id_header IS NOT NULL
    AND seq NOT IN (SELECT MIN(seq) FROM messages WHERE direction = 'in' AND message_id_header IS NOT NULL GROUP BY inbox_id, message_id_header)
);
DELETE FROM messages
WHERE direction = 'in' AND message_id_header IS NOT NULL
  AND seq NOT IN (SELECT MIN(seq) FROM messages WHERE direction = 'in' AND message_id_header IS NOT NULL GROUP BY inbox_id, message_id_header);
DELETE FROM threads WHERE message_count <= 0 AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = threads.id);

-- Outbound rows are excluded: a message you send to your own inbox arrives with the same Message-ID.
CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_msgid ON messages(inbox_id, message_id_header)
  WHERE message_id_header IS NOT NULL AND direction = 'in';

-- 2. Text cap flag. Rows cut at the old 500k-character cap are marked; existing bodies are not
--    rewritten (the FTS index is kept in sync on insert/delete only).
ALTER TABLE messages ADD COLUMN text_truncated INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET text_truncated = 1 WHERE direction = 'in' AND length(text_body) >= 500000;

-- 3. Inbound messages per inbox.
ALTER TABLE inboxes ADD COLUMN inbound_count INTEGER NOT NULL DEFAULT 0;
UPDATE inboxes SET inbound_count = (SELECT COUNT(*) FROM messages WHERE inbox_id = inboxes.id AND direction = 'in');
CREATE TRIGGER IF NOT EXISTS inboxes_inbound_ai AFTER INSERT ON messages WHEN new.direction = 'in' BEGIN
  UPDATE inboxes SET inbound_count = inbound_count + 1 WHERE id = new.inbox_id;
END;
CREATE TRIGGER IF NOT EXISTS inboxes_inbound_ad AFTER DELETE ON messages WHEN old.direction = 'in' BEGIN
  UPDATE inboxes SET inbound_count = MAX(inbound_count - 1, 0) WHERE id = old.inbox_id;
END;

-- 4. Inbound messages per account per UTC day. Rows older than a week are pruned by the cron.
CREATE TABLE IF NOT EXISTS inbound_counters (
  account_id  TEXT NOT NULL,
  day         TEXT NOT NULL,                            -- YYYY-MM-DD (UTC)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
