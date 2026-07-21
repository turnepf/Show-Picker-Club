-- Re-runnable backfill of the consolidated TMDB rating (follows migration 043).
--
-- 043 did two things in one file: ADD COLUMN director_imdb_id, then backfill
-- `rating` from `tmdb_rating`. Once the column exists, re-running 043 fails on
-- the ALTER ("duplicate column name") — which means if the ALTER half applied
-- but the backfill half didn't, 043 can never be re-run to finish the job.
--
-- This migration is JUST the backfill and is idempotent (a second run matches
-- no rows), so it can be applied safely and repeatedly to guarantee every row's
-- `rating` equals its TMDB score. Harmless no-op if 043's backfill already ran.
--
-- Apply with (note the migrations/ path prefix):
--   wrangler d1 execute shows-db --remote --file=migrations/044_backfill_tmdb_rating.sql

UPDATE shows
   SET rating = tmdb_rating
 WHERE tmdb_rating IS NOT NULL AND tmdb_rating != ''
   AND (rating IS NULL OR rating != tmdb_rating);
