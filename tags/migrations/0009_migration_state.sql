-- What the site used before, and whether it was brought over. Additive: existing rows get NULL
-- (GET /v1/containers/:id answers null), and the previous release never reads these columns.

-- The last POST /scan: { at, url, tools: [{ tool, id?, where? }], ours: { container, analytics } }
-- (normalised tool slugs and validated ids only, never free text from the page).
ALTER TABLE containers ADD COLUMN last_scan TEXT;

-- The last POST /draft/import that wasn't a dry run: { at, format, mode, summary }.
ALTER TABLE containers ADD COLUMN last_import TEXT;
