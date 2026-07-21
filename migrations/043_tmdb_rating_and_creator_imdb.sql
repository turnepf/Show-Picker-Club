-- Consolidate on a single TMDB rating (OMDB retired) and add a creator/director
-- IMDB id for the detail-screen person link.
--
-- Ratings: `rating` used to hold the IMDB score fetched from OMDB, alongside the
-- newer `tmdb_rating` (migration 042). We've dropped OMDB, so `rating` now
-- carries TMDB's audience score — the enrichment passes fill it from TMDB going
-- forward. Backfill existing rows from the TMDB score captured in 042 so the
-- switch is consistent immediately; rows without a TMDB score yet keep their
-- prior value until the next enrichment pass reaches them. `tmdb_rating` is
-- kept (older app versions still read it — it now mirrors `rating`).
--
--   director_imdb_id — IMDB id (nm…) of the creator (TV) or director (movie),
--                      resolved from TMDB external_ids. NULL until enrichment
--                      fills it; the detail screen links the name to the IMDB
--                      person page only when the credit is a single person.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/043_tmdb_rating_and_creator_imdb.sql

ALTER TABLE shows ADD COLUMN director_imdb_id TEXT;

UPDATE shows
   SET rating = tmdb_rating
 WHERE tmdb_rating IS NOT NULL AND tmdb_rating != ''
   AND (rating IS NULL OR rating != tmdb_rating);
