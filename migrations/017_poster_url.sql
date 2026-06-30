-- Poster artwork for shows, sourced from TMDB during enrichment (full image
-- URL, e.g. https://image.tmdb.org/t/p/w500/...). Powers the Apple TV cards and
-- detail screen; null until a show is enriched. Backfilled as the TMDB pass in
-- /api/enrich rotates through the library.
ALTER TABLE shows ADD COLUMN poster_url TEXT;
