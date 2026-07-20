-- Rename "Bernie's" to "Bernie" — the second of the three titles the
-- off-platform batch import (032) flagged as having no clear canonical match,
-- so it never resolved on TMDB and never got a poster. Same failure mode and
-- fix pattern as the Marshals correction (037).
--
-- Scoped by title, not member, so it corrects whoever has the row. Clearing
-- enriched_at sends it to the front of the oldest-first TMDB pass; enrichment
-- tries both tv and movie indexes, so the media-type flag doesn't block the
-- match.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/038_fix_bernie_title.sql
--
-- Idempotent: after the first pass no row matches the old title.

UPDATE shows
SET title = 'Bernie',
    enriched_at = NULL
WHERE LOWER(title) = 'bernie''s'
  AND archived = 0
  -- Don't create a duplicate if a copy under the real title already exists
  -- for the same member.
  AND NOT EXISTS (
    SELECT 1 FROM shows s2
    WHERE LOWER(s2.title) = 'bernie'
      AND s2.member_slug = shows.member_slug
      AND s2.archived = 0
  );
