-- Stored bytes per account (MAX_BLOB_BYTES_PER_ACCOUNT), and one copy of each received attachment.
--   - messages.blob_bytes: the bytes this message keeps in R2: its raw MIME and HTML body, plus the
--     attachment objects of sent mail (and of mail received before this migration).
--   - account_usage.blob_bytes: their sum per account, kept by the same triggers as text_bytes, so
--     it always equals what the account's current rows hold: deleting mail (by hand, eviction,
--     retention, inbox expiry or deletion) frees budget at once.
--   - attachments.part_index: attachments of received mail are no longer copied into R2 objects of
--     their own (the raw MIME already holds them); a download parses the stored raw message and
--     returns its attachment at this position. Such rows have r2_key ''. NULL = an own R2 object
--     at r2_key (sent mail, and mail received before this migration).

ALTER TABLE messages ADD COLUMN blob_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET blob_bytes =
    (CASE WHEN raw_key IS NOT NULL THEN COALESCE(size, 0) ELSE 0 END)
  + (CASE WHEN html_key IS NOT NULL THEN COALESCE(html_size, 0) ELSE 0 END)
  + (SELECT COALESCE(SUM(a.size), 0) FROM attachments a WHERE a.message_id = messages.id);

ALTER TABLE attachments ADD COLUMN part_index INTEGER;

ALTER TABLE account_usage ADD COLUMN blob_bytes INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO account_usage (account_id, text_bytes) SELECT DISTINCT account_id, 0 FROM messages;
UPDATE account_usage SET blob_bytes = (SELECT COALESCE(SUM(blob_bytes), 0) FROM messages WHERE account_id = account_usage.account_id);

DROP TRIGGER IF EXISTS messages_usage_ai;
DROP TRIGGER IF EXISTS messages_usage_ad;
CREATE TRIGGER messages_usage_ai AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO account_usage (account_id, text_bytes, blob_bytes) VALUES (new.account_id, 0, 0);
  UPDATE account_usage
    SET text_bytes = text_bytes + COALESCE(length(CAST(new.text_body AS BLOB)), 0) + COALESCE(length(CAST(new.links_json AS BLOB)), 0),
        blob_bytes = blob_bytes + new.blob_bytes
    WHERE account_id = new.account_id;
END;
CREATE TRIGGER messages_usage_ad AFTER DELETE ON messages BEGIN
  UPDATE account_usage
    SET text_bytes = MAX(text_bytes - COALESCE(length(CAST(old.text_body AS BLOB)), 0) - COALESCE(length(CAST(old.links_json AS BLOB)), 0), 0),
        blob_bytes = MAX(blob_bytes - old.blob_bytes, 0)
    WHERE account_id = old.account_id;
END;
