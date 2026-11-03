-- API keys can expire (OAuth access tokens minted by the site). authenticate() selects this column,
-- so standalone deployments (keys in this DB, no AUTH_DB) need it too. NULL = never expires.
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
