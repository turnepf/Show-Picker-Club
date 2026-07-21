-- Office Romance: correct the media-type flag so it gets a poster.
--
-- Follow-up to 039 (which only cleared enriched_at). "Office Romance" is the
-- 2026 Jennifer Lopez rom-com, indexed on TMDB only as a *movie*
-- (themoviedb.org/movie/1358005), but the off-platform batch import (032) filed
-- it as a show (movie = 0). The background enricher's poster passes are
-- media-type-siloed by design (the cross-type guessing was retired in July 2026,
-- b1ecd34) — the TV pass searches only TMDB's TV index and the movie pass skips
-- any row whose flag says it isn't a movie — so a show-flagged row that exists
-- only as a movie on TMDB never matches.
--
-- 039 already ran in production, so its file can't be edited in place; this
-- separate migration sets the correct flag. movie = 1 hands the row to the
-- movie poster pass; clearing enriched_at sorts it to the front so the poster
-- lands on the next enrich run. Title-scoped (every member's copy); guarded on
-- movie = 0 so a re-run is a no-op. updated_at is untouched (member-intent only).
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/041_office_romance_movie_flag.sql

UPDATE shows
SET movie = 1,
    enriched_at = NULL
WHERE LOWER(title) = 'office romance'
  AND archived = 0
  AND movie = 0;
