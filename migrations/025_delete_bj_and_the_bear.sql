-- Delete "B.J. and the Bear" from the database.
--
-- Removes the show row(s), their cast rows, and the orphaned trait vector.
-- Actors would normally cascade with the show (ON DELETE CASCADE), but they
-- are deleted explicitly first so the result doesn't depend on foreign-key
-- enforcement being on. Title matching is case-insensitive and covers the
-- punctuation variants a member might have typed ("B.J." / "BJ" / "B. J.").
--
-- Auto-applied on deploy by scripts/apply-migrations.sh, or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/025_delete_bj_and_the_bear.sql
--
-- Idempotent: after the first pass no row matches.

DELETE FROM actors
WHERE show_id IN (
  SELECT id FROM shows
  WHERE LOWER(title) IN ('b.j. and the bear', 'bj and the bear', 'b. j. and the bear')
);

DELETE FROM shows
WHERE LOWER(title) IN ('b.j. and the bear', 'bj and the bear', 'b. j. and the bear');

DELETE FROM show_traits
WHERE title_lower IN ('b.j. and the bear', 'bj and the bear', 'b. j. and the bear');
