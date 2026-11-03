-- Custom domains: per-account claims plus an ownership challenge.
--
-- Before: one row per domain (first come, first served) and "verified" meant DNS alone, so any
-- account could take a domain whose MX already pointed at Cloudflare. Now any number of accounts
-- may claim a domain; a claim gives no rights until its account passes the TXT challenge
-- (_afs-verify.<domain> = afs-verify=<token>, see src/service/domains.ts). The first account to pass
-- becomes the owner (owner_verified_at), the other claims are removed, and only the owner's domain
-- receives mail, sends, or gets inboxes.
--
-- Existing rows start unproven (owner_verified_at NULL, status 'verified' -> 'partial'): their
-- accounts add the challenge record shown by GET /v1/domains/:domain and run verify once.
-- SQLite cannot drop the column-level UNIQUE(domain), so the table is rebuilt. Nothing references
-- domains(id).
PRAGMA defer_foreign_keys = true;

CREATE TABLE domains_new (
  id                  TEXT PRIMARY KEY,                 -- dom_xxx
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain              TEXT NOT NULL,                    -- lowercase ASCII (punycode)
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | partial | verified (ownership + receiving + sending)
  receiving_verified  INTEGER NOT NULL DEFAULT 0,
  sending_verified    INTEGER NOT NULL DEFAULT 0,
  catch_all_inbox_id  TEXT,                             -- unknown local parts land here (else rejected)
  records_json        TEXT NOT NULL,                    -- required email DNS records (see src/lib/dns.ts)
  last_check_json     TEXT,                             -- last verify result
  checked_at          INTEGER,
  verified_at         INTEGER,
  cf_zone_id          TEXT,                             -- set by auto_configure
  auto_config_json    TEXT,                             -- last auto_configure report
  owner_verified_at   INTEGER,                          -- when this account passed the ownership challenge
  created_at          INTEGER NOT NULL,
  UNIQUE (account_id, domain)
);

INSERT INTO domains_new (id, account_id, domain, status, receiving_verified, sending_verified, catch_all_inbox_id, records_json,
                         last_check_json, checked_at, verified_at, cf_zone_id, auto_config_json, owner_verified_at, created_at)
  SELECT id, account_id, domain, CASE WHEN status = 'verified' THEN 'partial' ELSE status END, receiving_verified, sending_verified,
         catch_all_inbox_id, records_json, last_check_json, checked_at, NULL, cf_zone_id, auto_config_json, NULL, created_at
  FROM domains;

DROP TABLE domains;
ALTER TABLE domains_new RENAME TO domains;

CREATE INDEX IF NOT EXISTS domains_account ON domains(account_id);
CREATE INDEX IF NOT EXISTS domains_domain ON domains(domain);
-- One owner per domain: at most one claim may have passed the challenge.
CREATE UNIQUE INDEX IF NOT EXISTS domains_owner ON domains(domain) WHERE owner_verified_at IS NOT NULL;
