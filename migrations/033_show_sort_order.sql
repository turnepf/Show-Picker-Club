-- Manual list ordering (2026-07): the "My order" sort on web + iOS lets a
-- member drag their list rows into a custom order. sort_order is the row's
-- position within its member's list; NULL = never manually placed (sinks
-- below ordered rows when the manual sort is active, invisible otherwise).
--
-- Written only by POST /api/shows/reorder. Deliberately does NOT bump
-- updated_at: reordering is presentation, not a content edit, and bumping
-- would mark every show on the list "active" in the reporting rollups.
--
-- Auto-applied on deploy by scripts/apply-migrations.sh, or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/033_show_sort_order.sql

ALTER TABLE shows ADD COLUMN sort_order INTEGER;
