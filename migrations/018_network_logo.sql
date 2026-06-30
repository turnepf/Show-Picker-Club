-- Network logo for shows, sourced from TMDB during enrichment (full image URL,
-- e.g. https://image.tmdb.org/t/p/w154/...). Powers the network mark in the
-- corner of the Apple TV poster cards; null until a show is enriched.
ALTER TABLE shows ADD COLUMN network_logo_url TEXT;
