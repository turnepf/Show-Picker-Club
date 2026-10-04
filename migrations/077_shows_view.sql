-- Step 2 of normalizing the library (docs/ARCHITECTURE.md#titles).
-- shows_v has exactly the columns of `shows`, with the title and the show's
-- details taken from `titles` (migration 076) when the entry has a row there.
-- Member-facing reads use it; writes still go to `shows`. Generated from
-- viewSql() in functions/_shared/titles.js; scripts/titles-test.mjs fails if
-- the two drift apart.
DROP VIEW IF EXISTS shows_v;
CREATE VIEW shows_v AS
  SELECT s.id AS id,
    COALESCE(t.name, s.title) AS title,
    s.network AS network,
    s.network_url AS network_url,
    s.recommended_by AS recommended_by,
    COALESCE(t.rating, s.rating) AS rating,
    s.list AS list,
    s.notes AS notes,
    s.movie AS movie,
    COALESCE(t.full_series, s.full_series) AS full_series,
    s.watching_with AS watching_with,
    s.next_season_date AS next_season_date,
    s.season_end_date AS season_end_date,
    COALESCE(t.seasons_released, s.seasons_released) AS seasons_released,
    COALESCE(t.poster_url, s.poster_url) AS poster_url,
    s.network_logo_url AS network_logo_url,
    s.title_ok AS title_ok,
    s.sort_order AS sort_order,
    s.archived AS archived,
    s.member_slug AS member_slug,
    s.created_at AS created_at,
    s.updated_at AS updated_at,
    s.added_by AS added_by,
    s.enriched_at AS enriched_at,
    COALESCE(t.genres, s.genres) AS genres,
    COALESCE(t.overview, s.overview) AS overview,
    COALESCE(t.backdrop_url, s.backdrop_url) AS backdrop_url,
    COALESCE(t.tmdb_rating, s.tmdb_rating) AS tmdb_rating,
    COALESCE(t.content_rating, s.content_rating) AS content_rating,
    COALESCE(t.trailer_key, s.trailer_key) AS trailer_key,
    COALESCE(t.director, s.director) AS director,
    COALESCE(t.director_imdb_id, s.director_imdb_id) AS director_imdb_id,
    COALESCE(t.runtime, s.runtime) AS runtime,
    COALESCE(t.release_year, s.release_year) AS release_year,
    COALESCE(t.watch_link, s.watch_link) AS watch_link,
    s.tmdb_id AS tmdb_id,
    s.tmdb_type AS tmdb_type,
    COALESCE(t.episodes_released, s.episodes_released) AS episodes_released,
    COALESCE(t.vote_count, s.vote_count) AS vote_count,
    COALESCE(t.tagline, s.tagline) AS tagline,
    COALESCE(t.original_language, s.original_language) AS original_language,
    COALESCE(t.studio, s.studio) AS studio,
    COALESCE(t.streaming_on, s.streaming_on) AS streaming_on,
    COALESCE(t.imdb_id, s.imdb_id) AS imdb_id,
    COALESCE(t.tmdb_status, s.tmdb_status) AS tmdb_status,
    COALESCE(t.free_on, s.free_on) AS free_on
    FROM shows s
    LEFT JOIN titles t
      ON t.tmdb_id = s.tmdb_id
     AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END);
