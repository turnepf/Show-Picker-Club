-- Migration 050's Saltburn fix included "AND archived = 0", but the TMDB
-- backfill (admin-tmdb-backfill, migration 049) doesn't filter by archived
-- at all — it covers archived rows too, same as the ratings feature this
-- is for. The "Salt Burn" row turned out to be archived, so 050 silently
-- skipped it while the Malcolm in the Middle fix (an active row) went
-- through fine.
--
-- This time: rename it (no archived restriction), and set tmdb_id directly
-- from https://www.themoviedb.org/movie/930564-saltburn rather than
-- relying on the next backfill pass's title search to find it.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/051_fix_saltburn_archived.sql
--
-- Idempotent: after the first pass no row matches the old title, and the
-- tmdb_id backfill only touches rows still missing it.

UPDATE shows
SET title = 'Saltburn'
WHERE LOWER(title) = 'salt burn'
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'saltburn'
      AND s2.member_slug = shows.member_slug
  );

UPDATE shows
SET tmdb_id = 930564,
    tmdb_type = 'movie'
WHERE LOWER(title) IN ('salt burn', 'saltburn')
  AND tmdb_id IS NULL;
