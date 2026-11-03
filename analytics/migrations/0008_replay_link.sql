-- Session replay linked to this site: the tracker loads that replay site's recorder by itself
-- (REPLAY_BASE_URL/r/<replay_site_id>.js), so linking is all it takes. Set by the replay app when
-- one of its sites names this analytics site, or with PATCH /v1/sites/:id. NULL = not linked.
-- Forward-only and additive: the previous release never selects this column.
ALTER TABLE sites ADD COLUMN replay_site_id TEXT;
