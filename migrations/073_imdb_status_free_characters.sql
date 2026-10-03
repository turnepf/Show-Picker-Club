-- Four facts TMDB already sends on the detail call enrichment makes, which
-- were read and dropped. None needs an extra request, and none is backfilled
-- here: the nightly rotation and member page loads fill them as titles come
-- up, Watching and Next Up first (see the ordering in functions/api/enrich.js).
--
--   shows.imdb_id      The title's IMDb id (tt…), for the IMDb link on the
--                      detail screen. TV gets it from the appended
--                      external_ids; a movie's detail payload carries it at
--                      the top level.
--   shows.tmdb_status  TMDB's status string, verbatim: "Returning Series",
--                      "Ended", "Canceled", "In Production", "Released", …
--                      full_series has been derived from it for years and
--                      the word itself thrown away, so "Ended" and
--                      "Canceled" read alike. Written '' when TMDB sends no
--                      status, so NULL keeps meaning "no pass has stored the
--                      new fields yet" — the enrichment ordering keys on it.
--   shows.free_on      Free and free-with-ads services (TMDB's `free` and
--                      `ads` provider lists: Tubi, Pluto TV, The Roku
--                      Channel…). Only the flatrate list was read, so a title
--                      free on Tubi looked as if it streamed nowhere. Same
--                      encoding as streaming_on: comma-separated names, ''
--                      when TMDB was asked and named none, NULL when never
--                      asked. Refreshed authoritatively, like streaming_on.
--   actors.character_name  The role ("Mark S."), from the same credits block
--                      that supplies the actor. Cast rows are replaced
--                      wholesale on every enrichment pass, so existing rows
--                      pick it up as their title comes round.
ALTER TABLE shows ADD COLUMN imdb_id TEXT;
ALTER TABLE shows ADD COLUMN tmdb_status TEXT;
ALTER TABLE shows ADD COLUMN free_on TEXT;
ALTER TABLE actors ADD COLUMN character_name TEXT;
