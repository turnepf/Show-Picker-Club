-- Kick "Office Romance" back into the enrichment queue so it picks up a poster.
--
-- It's the 2026 Jennifer Lopez rom-com, which TMDB indexes only as a *movie*
-- (themoviedb.org/movie/1358005). The row is filed as a show (movie = 0), and
-- the background enricher's poster passes were media-type-siloed — the TV pass
-- searched only TMDB's TV index (no match) and the movie pass ignored the row
-- because its flag said it wasn't a movie. So it never got a poster.
--
-- The siloing is fixed in code (functions/api/enrich.js now falls back to the
-- other index when the first search is empty). Clearing enriched_at pushes the
-- row to the front of the oldest-first pass so the poster lands on the next
-- enrich run instead of waiting for the row to rotate up on its own.
--
-- Title-scoped so it covers every member's copy. poster_url is already NULL;
-- this only re-queues it. updated_at is untouched (member-intent only).
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/039_reenrich_office_romance.sql

UPDATE shows
SET enriched_at = NULL
WHERE LOWER(title) = 'office romance'
  AND archived = 0
  AND poster_url IS NULL;
