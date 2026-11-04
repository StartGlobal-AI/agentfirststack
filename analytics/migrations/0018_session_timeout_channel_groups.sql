-- Wave 2: a per-site session timeout (minutes of inactivity that end a session; NULL = 30) and
-- custom channel groups (JSON rules over source / medium / campaign, evaluated at query time).
ALTER TABLE sites ADD COLUMN session_timeout_minutes INTEGER;
ALTER TABLE sites ADD COLUMN channel_groups TEXT;
