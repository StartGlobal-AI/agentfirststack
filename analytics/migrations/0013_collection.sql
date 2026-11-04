-- Wave 1, collection. Forward-only and additive: the previous release never selects these columns.

-- Site search: the query parameters that carry a search term (JSON array, at most 5; NULL = off).
-- A pageview carrying one also records a site_search event {term}; the rest of the query string
-- is still never stored.
ALTER TABLE sites ADD COLUMN search_params TEXT;

-- Content groups: [{"name": "Blog", "match": "/blog/*"}], first match wins, evaluated at query time
-- (so they apply to stored data too). NULL = none.
ALTER TABLE sites ADD COLUMN content_groups TEXT;
