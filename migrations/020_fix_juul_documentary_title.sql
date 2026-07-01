-- Rename "Juul Documentary" to its real title, "Big Vape: The Rise and Fall
-- of Juul" (Netflix docuseries, 2023). The member-entered name was a
-- description, not a title, so TMDB/OMDB could never match it — no poster,
-- rating, or cast. The Netflix deep link on the row is correct and stays.
--
-- Clearing enriched_at sends the row to the front of the oldest-first TMDB
-- pass so the poster/rating/cast backfill on the next enrich run.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/020_fix_juul_documentary_title.sql
--
-- Idempotent: after the first pass no row matches the old title.

UPDATE shows
SET title = 'Big Vape: The Rise and Fall of Juul',
    enriched_at = NULL
WHERE LOWER(title) = 'juul documentary'
  AND archived = 0
  -- Don't create a duplicate if a copy under the real title already exists
  -- for the same member.
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'big vape: the rise and fall of juul'
      AND s2.member_slug = shows.member_slug
      AND s2.archived = 0
  );
