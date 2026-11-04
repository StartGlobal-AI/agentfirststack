-- Domain verification, needed before a site may publish share links (a public page naming the
-- domain): verify found this site's tracker in a <script src ... data-site> tag on exactly
-- https://<domain>/, or the DNS TXT record _afs-verify.<domain> = "afs-analytics-site=<site_id>".
-- Changing a site's domain clears both.
ALTER TABLE sites ADD COLUMN verified_at INTEGER;
ALTER TABLE sites ADD COLUMN verify_method TEXT;            -- homepage | dns_txt | dev_localhost
