-- Abuse handling (docs/operations.md, "Abuse").
--
-- Capability pauses (@afs/shared pauses.ts): one capability of one account stopped after a strong
-- abuse signal (mail.send, mail.inbox_create, tags.custom_code, replay.share_links,
-- analytics.share_links). Every service reads this table (cached a minute per isolate) where the
-- capability is used. One row per account and capability: lifting keeps the row (lifted_at), so an
-- automatic re-pause right after the operator's review waits PAUSE_LIFT_GRACE_HOURS. notified_at is
-- set once the project's people and the operator were emailed (the hourly cron catches up on rows a
-- service wrote directly).
CREATE TABLE IF NOT EXISTS capability_pauses (
  account_id  TEXT NOT NULL,
  capability  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  paused_at   INTEGER NOT NULL,
  -- the service that saw the signal (mail, tags, ...) or "operator"
  paused_by   TEXT NOT NULL,
  -- ends by itself then; NULL = until the operator lifts it
  until       INTEGER,
  -- JSON: the numbers behind the decision, for the operator
  details     TEXT,
  notified_at INTEGER,
  lifted_at   INTEGER,
  lifted_by   TEXT,
  PRIMARY KEY (account_id, capability)
);
CREATE INDEX IF NOT EXISTS capability_pauses_unnotified ON capability_pauses (paused_at) WHERE notified_at IS NULL AND lifted_at IS NULL;

-- Abuse reports (POST /v1/abuse-reports, the form at /report-abuse): public, no account. network is
-- a hash of the reporter's network (IPv4 address or IPv6 /48), for the per-network limit; contact
-- is what the reporter chose to give. Kept 180 days.
CREATE TABLE IF NOT EXISTS abuse_reports (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  details     TEXT NOT NULL,
  contact     TEXT,
  network     TEXT NOT NULL,
  -- new, reviewed (looked at, acted on or not), dismissed
  status      TEXT NOT NULL DEFAULT 'new',
  note        TEXT,
  created_at  INTEGER NOT NULL,
  emailed_at  INTEGER,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS abuse_reports_created ON abuse_reports (created_at);
CREATE INDEX IF NOT EXISTS abuse_reports_network ON abuse_reports (network, created_at);
