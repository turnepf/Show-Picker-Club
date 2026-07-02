-- Rename "Nate Bargatze Stand Up" to its real title, "Your Friend, Nate
-- Bargatze" (Netflix stand-up special). Descriptive member-entered name, so
-- TMDB/OMDB search can't match it — same failure mode as the Juul fix (020).
--
-- Clearing enriched_at sends the row to the front of the oldest-first TMDB
-- pass so the poster/rating backfill on the next enrich run.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/021_fix_nate_bargatze_title.sql
--
-- Idempotent: after the first pass no row matches the old title.

UPDATE shows
SET title = 'Your Friend, Nate Bargatze',
    enriched_at = NULL
WHERE LOWER(title) = 'nate bargatze stand up'
  AND archived = 0
  -- Don't create a duplicate if a copy under the real title already exists
  -- for the same member.
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'your friend, nate bargatze'
      AND s2.member_slug = shows.member_slug
      AND s2.archived = 0
  );
