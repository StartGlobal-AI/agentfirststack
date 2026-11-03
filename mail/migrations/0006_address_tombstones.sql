-- Shared-domain addresses are never recycled. When an inbox on the shared MAIL_DOMAIN is deleted
-- (by its account or by ttl expiry) its address is recorded here for good, in the same batch. Only
-- the account that owned it may create it again; for anyone else it answers exactly like an address
-- taken by another account (409), so the two cannot be told apart. No foreign key: the tombstone
-- outlives the account.
CREATE TABLE IF NOT EXISTS address_tombstones (
  address     TEXT PRIMARY KEY,                         -- normalised local@MAIL_DOMAIN
  account_id  TEXT NOT NULL,                            -- the account that owned it
  deleted_at  INTEGER NOT NULL
);
