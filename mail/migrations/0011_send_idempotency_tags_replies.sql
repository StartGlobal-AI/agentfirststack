-- Send idempotency, plus-address tags and reply text. Additive: new table, new columns, and the
-- usage triggers recreated to also count the new text column.

-- 1. Idempotency-Key on send / reply / forward. One row per (account, key) for 24 h: the body hash
--    it was first used with and the response that was returned, replayed for a retry with the same
--    body (409 for another body). response_json is NULL while the send is in progress. The cron
--    deletes expired rows. Rows are bounded by sends (SEND_DAILY_LIMIT): a failed send deletes its row.
CREATE TABLE IF NOT EXISTS send_keys (
  account_id     TEXT NOT NULL,
  key            TEXT NOT NULL,                         -- Idempotency-Key header, 1-256 of [A-Za-z0-9._~-]
  body_hash      TEXT NOT NULL,                         -- sha256 of the route + target + canonical JSON body
  message_id     TEXT,                                  -- msg_ of the stored copy, once sent
  response_json  TEXT,                                  -- the response to replay; NULL = in progress
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS send_keys_expiry ON send_keys(expires_at);

-- 2. The plus-address tag of an inbound message's recipient (me+github@ -> "github"), for the
--    tag= filter on wait, latest-code and lists. Backfilled from the envelope recipient.
ALTER TABLE messages ADD COLUMN tag TEXT;
UPDATE messages
  SET tag = lower(substr(substr(envelope_to, 1, instr(envelope_to, '@') - 1),
                         instr(substr(envelope_to, 1, instr(envelope_to, '@') - 1), '+') + 1, 64))
  WHERE direction = 'in' AND envelope_to IS NOT NULL AND instr(envelope_to, '@') > 0
    AND instr(substr(envelope_to, 1, instr(envelope_to, '@') - 1), '+') > 0;
UPDATE messages SET tag = NULL WHERE tag = '' OR tag GLOB '*[^a-z0-9._=-]*';
CREATE INDEX IF NOT EXISTS messages_inbox_tag ON messages(inbox_id, tag, received_at) WHERE tag IS NOT NULL;

-- 3. reply_text: text_body without the quoted history (src/extract/reply.ts). NULL = the same as
--    text_body (nothing was quoted), so most rows store nothing extra. Older rows stay NULL.
ALTER TABLE messages ADD COLUMN reply_text TEXT;

-- 4. Stored text per account (MAX_TEXT_BYTES_PER_ACCOUNT) now counts reply_text too. Existing rows
--    have none, so account_usage needs no correction.
DROP TRIGGER IF EXISTS messages_usage_ai;
DROP TRIGGER IF EXISTS messages_usage_ad;
CREATE TRIGGER messages_usage_ai AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO account_usage (account_id, text_bytes, blob_bytes) VALUES (new.account_id, 0, 0);
  UPDATE account_usage
    SET text_bytes = text_bytes + COALESCE(length(CAST(new.text_body AS BLOB)), 0) + COALESCE(length(CAST(new.links_json AS BLOB)), 0)
                     + COALESCE(length(CAST(new.reply_text AS BLOB)), 0),
        blob_bytes = blob_bytes + new.blob_bytes
    WHERE account_id = new.account_id;
END;
CREATE TRIGGER messages_usage_ad AFTER DELETE ON messages BEGIN
  UPDATE account_usage
    SET text_bytes = MAX(text_bytes - COALESCE(length(CAST(old.text_body AS BLOB)), 0) - COALESCE(length(CAST(old.links_json AS BLOB)), 0)
                     - COALESCE(length(CAST(old.reply_text AS BLOB)), 0), 0),
        blob_bytes = MAX(blob_bytes - old.blob_bytes, 0)
    WHERE account_id = old.account_id;
END;
