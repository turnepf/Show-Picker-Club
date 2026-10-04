-- Movies have no seasons or episodes, but rows that were matched to a TV
-- entry and later fixed into a movie kept that entry's counts: the edit path
-- wrote seasons_released fill-only, and a film's lookup has nothing to
-- overwrite it with. Found by scripts/tmdb-audit.mjs cleanup (2026-10-04),
-- seven rows, e.g. "Sinners" showing 6 seasons. The edit path now clears the
-- count for a movie; this clears the rows already affected.
UPDATE shows SET seasons_released = NULL, episodes_released = NULL
 WHERE movie = 1 AND (seasons_released IS NOT NULL OR episodes_released IS NOT NULL);
