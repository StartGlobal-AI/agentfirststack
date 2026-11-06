-- First-party domains (src/first-party-domains.ts): a subdomain of a customer's site (a CNAME to
-- the deployment's Cloudflare for SaaS fallback host) that serves the project's analytics, tags and
-- replay collection, so ad blockers that block analytics.* hosts don't drop visitors. One row per
-- hostname: the custom hostname and Worker route created for it in Cloudflare, and the status last
-- read from Cloudflare (refreshed on GET, at most every 30 seconds per hostname).
CREATE TABLE IF NOT EXISTS first_party_domains (
  hostname        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  cf_hostname_id  TEXT,
  route_id        TEXT,
  -- pending (waiting for the DNS record and certificate), active, or failed
  status          TEXT NOT NULL DEFAULT 'pending',
  -- Cloudflare's own words: the custom hostname's status and its certificate's
  cf_status       TEXT,
  ssl_status      TEXT,
  -- JSON: the ownership / certificate validation records Cloudflare asked for, and its errors
  records         TEXT,
  errors          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS first_party_domains_account ON first_party_domains (account_id, created_at);
