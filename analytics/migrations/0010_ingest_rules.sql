-- Wave 1, ingest rules. Forward-only and additive: the previous release never selects these
-- columns, so it keeps working against this schema.

-- Referrer hosts treated as no referrer (on top of the built-in payment / sign-in defaults):
-- JSON array of host patterns; NULL = none of the site's own.
ALTER TABLE sites ADD COLUMN ignored_referrers TEXT;

-- Path cleaning rules applied at ingest: JSON [{"match": "/users/*", "replace": "/users/:id"}]; NULL = none.
ALTER TABLE sites ADD COLUMN path_rules TEXT;

-- 1 = replace email addresses and phone numbers in paths, referrers, UTM tags and props with
-- [email] / [phone] before storing. On by default, existing sites included.
ALTER TABLE sites ADD COLUMN redact_pii INTEGER NOT NULL DEFAULT 1;
