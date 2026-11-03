-- Shared schema (copied into every app, like 0001_accounts.sql): account suspension, for abuse of
-- the free hosted service. A suspended account's keys stop working and its public ingest is refused.
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;
ALTER TABLE accounts ADD COLUMN suspended_reason TEXT;
