-- Every show is a TMDB entry (2026-10-05): a copy has no title of its own,
-- so shows_v takes the name from the shared row alone, where it used to fall
-- back to the copy's title. Views only, no row changes. This has to land
-- before shows.title is dropped (operator-run, see migrations/README.md):
-- SQLite won't drop a column a view still names. Generated from viewSql()
-- and actorsViewSql() in functions/_shared/titles.js.
DROP VIEW IF EXISTS shows_v;
CREATE VIEW shows_v AS
  SELECT s.id AS id,
    t.name AS title,
    s.network AS network,
    s.network_url AS network_url,
    s.recommended_by AS recommended_by,
    t.rating AS rating,
    s.list AS list,
    s.notes AS notes,
    s.movie AS movie,
    s.full_series AS full_series,
    s.watching_with AS watching_with,
    s.next_season_date AS next_season_date,
    s.season_end_date AS season_end_date,
    t.seasons_released AS seasons_released,
    t.poster_url AS poster_url,
    s.network_logo_url AS network_logo_url,
    s.title_ok AS title_ok,
    s.sort_order AS sort_order,
    s.archived AS archived,
    s.member_slug AS member_slug,
    s.created_at AS created_at,
    s.updated_at AS updated_at,
    s.added_by AS added_by,
    s.enriched_at AS enriched_at,
    t.genres AS genres,
    t.overview AS overview,
    t.backdrop_url AS backdrop_url,
    t.tmdb_rating AS tmdb_rating,
    t.content_rating AS content_rating,
    t.trailer_key AS trailer_key,
    t.director AS director,
    t.director_imdb_id AS director_imdb_id,
    t.runtime AS runtime,
    t.release_year AS release_year,
    t.watch_link AS watch_link,
    s.tmdb_id AS tmdb_id,
    s.tmdb_type AS tmdb_type,
    t.episodes_released AS episodes_released,
    t.vote_count AS vote_count,
    t.tagline AS tagline,
    t.original_language AS original_language,
    t.studio AS studio,
    t.streaming_on AS streaming_on,
    t.imdb_id AS imdb_id,
    t.tmdb_status AS tmdb_status,
    t.free_on AS free_on
    FROM shows s
    LEFT JOIN titles t
      ON t.tmdb_id = s.tmdb_id
     AND t.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END);
DROP VIEW IF EXISTS actors_v;
CREATE VIEW actors_v AS
  SELECT tc.ord AS id, s.id AS show_id, tc.name AS name, tc.imdb_id AS imdb_id, tc.ord AS ord,
         tc.tmdb_person_id AS tmdb_person_id, tc.character_name AS character_name
    FROM shows s
    JOIN title_cast tc
      ON tc.tmdb_id = s.tmdb_id
     AND tc.tmdb_type = COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END);
