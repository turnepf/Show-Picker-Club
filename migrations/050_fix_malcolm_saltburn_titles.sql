-- Two titles that never matched TMDB during the ratings TMDB-id backfill
-- (migration 049 / admin-tmdb-backfill) because of bad title text, not a
-- real match failure — same failure mode as the Marshals fix (037):
--
-- "Malcolm in the middle: life is still unfair" -> "Malcolm in the Middle"
--   (garbled/extended title; the real show is just "Malcolm in the Middle").
-- "Salt Burn" -> "Saltburn" (the 2023 film's title is one word).
--
-- Scoped by title, not member, so it corrects whoever has the bad row.
-- Clearing enriched_at sends each to the front of the oldest-first backfill
-- pass so it picks up tmdb_id on the next run.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/050_fix_malcolm_saltburn_titles.sql
--
-- Idempotent: after the first pass no row matches the old titles.

UPDATE shows
SET title = 'Malcolm in the Middle',
    enriched_at = NULL
WHERE LOWER(title) = 'malcolm in the middle: life is still unfair'
  AND archived = 0
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'malcolm in the middle'
      AND s2.member_slug = shows.member_slug
      AND s2.archived = 0
  );

UPDATE shows
SET title = 'Saltburn',
    enriched_at = NULL
WHERE LOWER(title) = 'salt burn'
  AND archived = 0
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'saltburn'
      AND s2.member_slug = shows.member_slug
      AND s2.archived = 0
  );
