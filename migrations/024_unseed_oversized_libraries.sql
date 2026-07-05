-- Generalize 023: un-seed every library too big to be seeds.
--
-- Seeding (functions/api/admin-create-member.js) copies in exactly 2 shows
-- per list — never more. So any member holding MORE than 2 seed-stamped
-- shows on a single list can't actually be seeded: like Chuck (023), their
-- library was imported on their behalf and mis-stamped added_by = 'seed'
-- by the backfill when that column arrived. The stamp makes Reporting call
-- them "Seeds only" and excludes their picks from recommendations, the
-- vibe check, and Popular.
--
-- Clear the stamp back to NULL (the documented pre-column, member-added
-- value) on ALL seed-stamped rows of any member whose seed-stamped rows
-- exceed 2 on any list. Genuinely seeded members are untouched: their seed
-- rows are always ≤ 2 per list, and shows they add themselves carry their
-- email, not 'seed'. Timestamps are left alone.
--
-- Auto-applied on deploy by scripts/apply-migrations.sh, or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/024_unseed_oversized_libraries.sql
--
-- Scoped to added_by = 'seed' so it's a no-op on re-run.

UPDATE shows
SET added_by = NULL
WHERE added_by = 'seed'
  AND member_slug IN (
    SELECT member_slug
    FROM shows
    WHERE added_by = 'seed'
    GROUP BY member_slug, list
    HAVING COUNT(*) > 2
  );
