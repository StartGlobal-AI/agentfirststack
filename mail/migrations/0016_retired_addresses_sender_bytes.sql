-- Security fixes (2026-11): addresses are retired for good, and storage cannot be filled by one sender.

-- 1. A deleted shared-domain address is never given to another account (src/service/inboxes.ts
--    deleteInbox). Until now a tombstone was written only for an address that had received mail,
--    and it lapsed after ADDRESS_TOMBSTONE_DAYS (90), after which anyone could create the address
--    and run "forgot password" on every service the old owner signed up with. Now every deleted
--    shared-domain address gets a tombstone that never lapses, and the cron no longer prunes them.
--    Existing tombstones (live or lapsed but not yet pruned) become permanent here. The table keeps
--    only the address, the account that may create it again and when it was deleted. `permanent`
--    stays for older code paths and is always 1 from now on.
UPDATE address_tombstones SET permanent = 1 WHERE permanent = 0;
DROP INDEX IF EXISTS address_tombstones_expiring;

-- 2. Bytes per sender per account per UTC day (MAX_INBOUND_BYTES_PER_SENDER_PER_DAY), counted in the
--    same atomic upsert as the per-sender message count (src/service/ingest.ts admitSender).
ALTER TABLE sender_counters ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;

-- 3. Bytes of stored mail per sender key per account, kept by triggers like account_usage, so the
--    email() handler can tell in one primary-key read whether a sender holds a large share of a
--    nearly full account (it then refuses that sender's large messages, not everyone's mail).
--    Rows go when they reach 0.
CREATE TABLE IF NOT EXISTS sender_usage (
  account_id  TEXT NOT NULL,
  sender_key  TEXT NOT NULL,
  blob_bytes  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, sender_key)
);
INSERT OR IGNORE INTO sender_usage (account_id, sender_key, blob_bytes)
  SELECT account_id, sender_key, SUM(blob_bytes) FROM messages
  WHERE direction = 'in' AND sender_key IS NOT NULL
  GROUP BY account_id, sender_key
  HAVING SUM(blob_bytes) > 0;
CREATE TRIGGER IF NOT EXISTS messages_sender_usage_ai AFTER INSERT ON messages
  WHEN new.direction = 'in' AND new.sender_key IS NOT NULL AND new.blob_bytes > 0 BEGIN
  INSERT OR IGNORE INTO sender_usage (account_id, sender_key, blob_bytes) VALUES (new.account_id, new.sender_key, 0);
  UPDATE sender_usage SET blob_bytes = blob_bytes + new.blob_bytes
    WHERE account_id = new.account_id AND sender_key = new.sender_key;
END;
CREATE TRIGGER IF NOT EXISTS messages_sender_usage_ad AFTER DELETE ON messages
  WHEN old.direction = 'in' AND old.sender_key IS NOT NULL AND old.blob_bytes > 0 BEGIN
  UPDATE sender_usage SET blob_bytes = MAX(blob_bytes - old.blob_bytes, 0)
    WHERE account_id = old.account_id AND sender_key = old.sender_key;
  DELETE FROM sender_usage WHERE account_id = old.account_id AND sender_key = old.sender_key AND blob_bytes <= 0;
END;
