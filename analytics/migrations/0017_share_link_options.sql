-- Wave 2: share links with a password (PBKDF2-SHA256 hash, never the password), an expiry, a saved
-- segment the dashboard is filtered by, and a label (the natural key of a link with options).
ALTER TABLE share_links ADD COLUMN password_hash TEXT;
ALTER TABLE share_links ADD COLUMN expires_at INTEGER;
ALTER TABLE share_links ADD COLUMN segment_id TEXT;
ALTER TABLE share_links ADD COLUMN label TEXT;
