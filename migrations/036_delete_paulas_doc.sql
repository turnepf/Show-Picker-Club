-- Delete "Doc" from Paula's library (2026-07).
--
-- Paula added a "Doc" that enrichment resolved to the wrong title, and the
-- add dedupe (which matches canonical titles) now blocks her from adding
-- the one she actually wants. Scoped to Paula's rows only — any other
-- member's copy stays. Cast rows are deleted explicitly first so the
-- result doesn't depend on foreign-key enforcement being on (025
-- precedent). The shared 'doc' trait vector is cleared so the scheduled
-- vibe fill re-scores against whichever "Doc" the club actually keeps.
--
-- Paula is matched by slug or first name, so this works whatever her exact
-- slug is; if no member matches, every statement is a no-op.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh),
-- or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/036_delete_paulas_doc.sql
--
-- Idempotent: after the first pass no row matches.

DELETE FROM actors
WHERE show_id IN (
  SELECT id FROM shows
  WHERE LOWER(title) = 'doc'
    AND member_slug IN (SELECT slug FROM members WHERE slug = 'paula' OR first_name = 'Paula')
);

DELETE FROM shows
WHERE LOWER(title) = 'doc'
  AND member_slug IN (SELECT slug FROM members WHERE slug = 'paula' OR first_name = 'Paula');

DELETE FROM show_traits WHERE title_lower = 'doc';
