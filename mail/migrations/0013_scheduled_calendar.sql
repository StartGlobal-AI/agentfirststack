-- Scheduled sends and calendar invites. Additive: new columns and an index.

-- 1. Scheduled send (send_at on send / reply / forward): the message is stored with status
--    'scheduled' and goes out at scheduled_at (the inbox's Durable Object alarm, with the hourly
--    cron as a fallback). scheduled_json keeps what the stored row has no column for (custom X-*
--    headers). Deleting the message cancels it. MAX_SCHEDULED_PER_ACCOUNT caps them.
ALTER TABLE messages ADD COLUMN scheduled_at INTEGER;
ALTER TABLE messages ADD COLUMN scheduled_json TEXT;
CREATE INDEX IF NOT EXISTS messages_scheduled ON messages(scheduled_at) WHERE status = 'scheduled';

-- 2. Calendar invites: the first text/calendar part of a received message, parsed at ingest
--    (src/extract/calendar.ts) into { method, uid, summary, start, end, organizer, attendees, ... }.
ALTER TABLE messages ADD COLUMN calendar_json TEXT;
