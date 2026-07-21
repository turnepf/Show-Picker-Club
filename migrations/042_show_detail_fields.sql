-- Richer show-detail fields, all sourced from the TMDB detail call we already
-- make (one HTTP request via append_to_response — no extra subrequest budget)
-- plus TMDB's watch/providers. All nullable, backfilled by the enrichment
-- passes; none is member-entered, so none bumps updated_at.
--
--   overview       — plot synopsis (TMDB `overview`)
--   backdrop_url   — wide 16:9 hero art (TMDB `backdrop_path`, w780)
--   tmdb_rating    — TMDB audience score, "x.y" (distinct from `rating`, which
--                    is the IMDB score from OMDB)
--   content_rating — US maturity certification (TV-MA, R, …)
--   trailer_key    — YouTube video key for the trailer
--   director       — director (movie) or creator(s) (TV)
--   runtime        — minutes (movie runtime, or a TV episode's run time)
--   release_year   — first release / first-air year
--   watch_link     — TMDB/JustWatch "where to watch" page. A fallback ONLY:
--                    the frontend prefers the real deep-link network_url and
--                    shows this aggregator page only when no deep link exists.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/042_show_detail_fields.sql

ALTER TABLE shows ADD COLUMN overview TEXT;
ALTER TABLE shows ADD COLUMN backdrop_url TEXT;
ALTER TABLE shows ADD COLUMN tmdb_rating TEXT;
ALTER TABLE shows ADD COLUMN content_rating TEXT;
ALTER TABLE shows ADD COLUMN trailer_key TEXT;
ALTER TABLE shows ADD COLUMN director TEXT;
ALTER TABLE shows ADD COLUMN runtime INTEGER;
ALTER TABLE shows ADD COLUMN release_year INTEGER;
ALTER TABLE shows ADD COLUMN watch_link TEXT;
