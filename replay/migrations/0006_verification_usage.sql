-- Domain verification: a site gets full quotas, analytics forwarding and share links only once
-- verify found its loader on the domain's own homepage (https) or a DNS TXT record
-- _afs-verify.<domain> = "afs-replay-site=<site_id>". Until then: the trial quota.
ALTER TABLE sites ADD COLUMN verified_at INTEGER;
ALTER TABLE sites ADD COLUMN verify_method TEXT;            -- homepage | dns_txt | dev_localhost
-- The hourly cron kicks each site's Durable Object once a day (NULL = never: kicked first).
ALTER TABLE sites ADD COLUMN maintained_at INTEGER;
CREATE INDEX IF NOT EXISTS sites_maintained ON sites(maintained_at);
CREATE INDEX IF NOT EXISTS sites_account_verified ON sites(account_id, verified_at);

-- Daily usage per account ("*" = the whole deployment), reported by each site's Durable Object at
-- most once a minute; read back to enforce MAX_*_PER_ACCOUNT_PER_DAY and MAX_PLATFORM_*_PER_DAY.
-- No foreign key: "*" is not an account. Rows older than a week are dropped by the cron.
CREATE TABLE IF NOT EXISTS account_usage (
  account_id  TEXT NOT NULL,
  day         TEXT NOT NULL,                              -- UTC YYYY-MM-DD
  sessions    INTEGER NOT NULL DEFAULT 0,
  chunks      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  derived     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);
CREATE INDEX IF NOT EXISTS account_usage_day ON account_usage(day);

-- verify calls per account (MAX_VERIFY_PER_ACCOUNT_PER_HOUR); rows older than an hour are pruned.
CREATE TABLE IF NOT EXISTS verify_log (
  account_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verify_log_account ON verify_log(account_id, created_at);
