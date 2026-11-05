-- Shared schema (identity database): deleting a project. deleted_at stops it at once, like a
-- suspension; purge_after is when its data is erased everywhere (7 days later, until then its
-- owner can restore it); purged_at marks the erasure done. Only the id and these dates remain.
ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;
ALTER TABLE accounts ADD COLUMN deleted_by TEXT;
ALTER TABLE accounts ADD COLUMN purge_after INTEGER;
ALTER TABLE accounts ADD COLUMN purged_at INTEGER;
CREATE INDEX IF NOT EXISTS accounts_purge_after ON accounts (purge_after) WHERE purge_after IS NOT NULL AND purged_at IS NULL;
