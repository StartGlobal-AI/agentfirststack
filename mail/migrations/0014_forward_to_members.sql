-- Forward an inbox's mail to the project's members (the people who claimed it with Google
-- sign-in): each message as it arrives, or one daily digest (src/service/forward.ts). Additive:
-- new columns and a table; existing inboxes keep forwarding off.

-- 1. The setting, per inbox, and what has been sent.
ALTER TABLE inboxes ADD COLUMN forward_mode TEXT NOT NULL DEFAULT 'off';    -- each | digest | off
ALTER TABLE inboxes ADD COLUMN forward_digest_hour INTEGER NOT NULL DEFAULT 8; -- 0-23, local time in forward_timezone
ALTER TABLE inboxes ADD COLUMN forward_timezone TEXT NOT NULL DEFAULT 'UTC';  -- IANA name
ALTER TABLE inboxes ADD COLUMN forward_since INTEGER;              -- when forwarding was turned on (NULL while off)
ALTER TABLE inboxes ADD COLUMN forward_last_forwarded_at INTEGER;  -- last message forwarded on its own (mode each)
ALTER TABLE inboxes ADD COLUMN forward_last_digest_at INTEGER;     -- last digest sent (incl. the catch-up digest)
ALTER TABLE inboxes ADD COLUMN forward_digest_day TEXT;            -- local day (YYYY-MM-DD) of the last digest-hour digest: one per day
ALTER TABLE inboxes ADD COLUMN forward_paused_at INTEGER;          -- forwarding stopped for the day at the daily budget; the next digest says so
CREATE INDEX IF NOT EXISTS inboxes_forwarding ON inboxes(forward_mode) WHERE forward_mode != 'off';

-- 2. Messages waiting to be forwarded or put in a digest. Only mail that may be forwarded gets a
--    row (authenticated, not a bounce, auto-reply, our own forward or the setup test), written in
--    the transaction that stores the message, so nothing is lost when the live forward fails: the
--    hourly cron sends what is left. A row is claimed (claim, claimed_at) while it is being sent and
--    deleted once it was; a stale claim (a Worker that died) is taken over after 15 minutes. Rows go
--    with their message, and the cron drops rows older than 30 days (nobody claimed the project).
CREATE TABLE IF NOT EXISTS forward_queue (
  message_id   TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  inbox_id     TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'forward',   -- forward: on its own (each) and in digests | list: digests only (Auto-Submitted: auto-generated)
  received_at  INTEGER NOT NULL,
  claim        TEXT,
  claimed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS forward_queue_inbox ON forward_queue(inbox_id, received_at);
CREATE INDEX IF NOT EXISTS forward_queue_age ON forward_queue(received_at);
