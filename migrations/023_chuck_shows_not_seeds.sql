-- Chuck's shows are not seeds — he picked them himself.
--
-- Chuck is an original member (see migrations/001, 005, 006), created long
-- before /setup started copying in auto-picked starter rows, so nothing in
-- his library ever came from the seeding path. His rows nevertheless carry
-- added_by = 'seed', which makes every seed-only check treat his library as
-- untouched starter content: the Reporting page labels him "Seeds only",
-- recommendations and the vibe check skip him, and his picks are excluded
-- from Popular.
--
-- Clear the stamp back to NULL — the documented value for member-added rows
-- that predate the added_by column (docs/ARCHITECTURE.md, "Seed-only
-- definition"), which every check treats as real activity. Timestamps are
-- left alone so edit/new-show stats aren't distorted.
--
-- Auto-applied on deploy by scripts/apply-migrations.sh, or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/023_chuck_shows_not_seeds.sql
--
-- Scoped to added_by = 'seed' so it's a no-op on re-run.

UPDATE shows
SET added_by = NULL
WHERE member_slug = 'chuck'
  AND added_by = 'seed';
