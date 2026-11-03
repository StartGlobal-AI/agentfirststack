-- Abuse and cost controls for the free hosted service. Additive: existing rows keep working.

-- Domain verification (needed before a version with custom code can be published): a DNS TXT
-- record _afs-verify.<domain>, or this container's snippet on the domain's homepage over https.
ALTER TABLE containers ADD COLUMN verified_at INTEGER;
ALTER TABLE containers ADD COLUMN verified_method TEXT;   -- 'dns' | 'snippet'

-- Per-destination circuit breaker: consecutive failed delivery attempts; while
-- circuit_open_until is in the future, deliveries are skipped (logged with the reason).
ALTER TABLE destinations ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE destinations ADD COLUMN circuit_open_until INTEGER;
ALTER TABLE destinations ADD COLUMN last_failure TEXT;
ALTER TABLE destinations ADD COLUMN last_failure_at INTEGER;

-- Daily delivery counters ('account:<id>' and 'platform') per UTC day. Only ever incremented.
CREATE TABLE IF NOT EXISTS delivery_usage (
  scope  TEXT NOT NULL,
  day    TEXT NOT NULL,                                   -- YYYY-MM-DD (UTC)
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);
