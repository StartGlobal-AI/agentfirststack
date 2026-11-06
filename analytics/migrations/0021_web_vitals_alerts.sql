-- Web Vitals alerts (type web_vitals): which metric they watch (lcp | inp | cls) and the fewest page
-- loads with that metric a window needs before its p75 counts.
ALTER TABLE alerts ADD COLUMN metric TEXT;
ALTER TABLE alerts ADD COLUMN min_samples INTEGER;
