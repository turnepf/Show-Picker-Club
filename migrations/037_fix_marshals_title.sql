-- Rename "Marshalls" (retail-store spelling, double L) to its real title,
-- "Marshals" — the 2026 CBS / Paramount+ Yellowstone spin-off. It came in via
-- the off-platform batch import (032), which flagged it as one of three titles
-- with no clear canonical match, so it never matched TMDB and never got a
-- poster. Same failure mode as the Nate Bargatze fix (021).
--
-- Scoped by title, not member, so it corrects whoever has the misspelled row.
-- Clearing enriched_at sends it to the front of the oldest-first TMDB pass so
-- the poster/rating/cast backfill on the next enrich run.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/037_fix_marshals_title.sql
--
-- Idempotent: after the first pass no row matches the old title.

UPDATE shows
SET title = 'Marshals',
    enriched_at = NULL
WHERE LOWER(title) = 'marshalls'
  AND archived = 0
  -- Don't create a duplicate if a copy under the real title already exists
  -- for the same member.
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'marshals'
      AND s2.member_slug = shows.member_slug
      AND s2.archived = 0
  );
