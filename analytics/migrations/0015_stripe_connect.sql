-- Wave 2, Stripe in one call. Forward-only and additive: the previous release never selects these
-- columns, and a row it wrote (manual connect) simply has them NULL.

-- The restricted key (rk_...) used only for setup and backfill, sealed with ENCRYPTION_KEY.
ALTER TABLE integrations ADD COLUMN api_key_sealed TEXT;
-- The webhook endpoint we created in the account (we_...), so a re-run reuses it and disconnect removes it.
ALTER TABLE integrations ADD COLUMN endpoint_id TEXT;
-- Backfill progress (JSON): status, since, stage, cursor, counts, paused_until, error.
ALTER TABLE integrations ADD COLUMN backfill TEXT;
