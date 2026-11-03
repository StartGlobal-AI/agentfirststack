-- When the linked analytics site last confirmed it loads this replay site's recorder (its
-- replay_site_id names this site, so its tracker adds the loader by itself). NULL = not confirmed:
-- the analytics call failed, or the site isn't linked. Shown as loads_with_analytics.
-- Forward-only and additive: the previous release never selects this column.
ALTER TABLE sites ADD COLUMN analytics_linked_at INTEGER;
