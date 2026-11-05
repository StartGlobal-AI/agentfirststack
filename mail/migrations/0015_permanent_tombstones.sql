-- Permanent address reservations for deleted projects.
--
-- A deleted shared-domain address that received mail is tombstoned for ADDRESS_TOMBSTONE_DAYS
-- (0006, 0009): only its old account may create it again until then. When a deleted project's mail
-- is erased (DELETE /v1/account, src/service/purge.ts) its addresses are reserved for good instead:
-- they are often the recovery email of accounts on other services, and the project can never come
-- back to claim them, so a new owner could take those accounts over with password resets.
--   - permanent = 1: the tombstone never expires (createInbox treats it as live, the cron never
--     prunes it). Set by the purge, for the project's inboxes and for its tombstones still live.
ALTER TABLE address_tombstones ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0;

-- The cron prunes expired tombstones by deleted_at (permanent = 0 only), so its index leaves the
-- permanent ones out: they would otherwise pile up in the range it reads every hour.
DROP INDEX IF EXISTS address_tombstones_deleted;
CREATE INDEX IF NOT EXISTS address_tombstones_expiring ON address_tombstones(deleted_at) WHERE permanent = 0;

-- The purge makes a project's live tombstones permanent by account.
CREATE INDEX IF NOT EXISTS address_tombstones_account ON address_tombstones(account_id);
