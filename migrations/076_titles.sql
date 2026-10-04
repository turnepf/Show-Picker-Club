-- One row per TMDB entry: the show itself, as opposed to a member's copy of
-- it. Step 1 of normalizing the library (docs/ARCHITECTURE.md#titles).
-- Nothing reads these tables yet; functions/_shared/titles.js keeps them in
-- sync with `shows` so the next step can switch reads over. The backfill
-- below is generated from rebuildSql() in that file, and
-- scripts/titles-test.mjs fails if the two drift apart.
CREATE TABLE IF NOT EXISTS titles (
  tmdb_type TEXT NOT NULL CHECK (tmdb_type IN ('tv', 'movie')),
  tmdb_id INTEGER NOT NULL,
  -- TMDB's own name for the entry.
  name TEXT NOT NULL,
  overview TEXT, poster_url TEXT, backdrop_url TEXT, network_logo_url TEXT, tagline TEXT, genres TEXT,
  director TEXT, director_imdb_id TEXT, content_rating TEXT, trailer_key TEXT, runtime INTEGER, release_year INTEGER,
  rating TEXT, tmdb_rating TEXT, vote_count INTEGER, seasons_released INTEGER, episodes_released INTEGER, full_series INTEGER,
  next_season_date TEXT, season_end_date TEXT, streaming_on TEXT, free_on TEXT, studio TEXT, original_language TEXT,
  imdb_id TEXT, tmdb_status TEXT, watch_link TEXT,
  synced_at TEXT,
  PRIMARY KEY (tmdb_type, tmdb_id)
);
CREATE TABLE IF NOT EXISTS title_cast (
  tmdb_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  name TEXT NOT NULL,
  imdb_id TEXT,
  tmdb_person_id INTEGER,
  character_name TEXT,
  PRIMARY KEY (tmdb_type, tmdb_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_title_cast_person ON title_cast(tmdb_person_id);
-- Every lookup from a show copy to its entry goes through this.
CREATE INDEX IF NOT EXISTS idx_shows_tmdb ON shows(tmdb_id, tmdb_type);

-- Backfill.
WITH k AS (SELECT DISTINCT COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) AS tmdb_type, s.tmdb_id AS tmdb_id, NULL AS name
  FROM shows s WHERE s.tmdb_id IS NOT NULL)
    INSERT INTO titles (tmdb_type, tmdb_id, name, overview, poster_url, backdrop_url, network_logo_url, tagline, genres, director, director_imdb_id, content_rating, trailer_key, runtime, release_year, rating, tmdb_rating, vote_count, seasons_released, episodes_released, full_series, next_season_date, season_end_date, streaming_on, free_on, studio, original_language, imdb_id, tmdb_status, watch_link, synced_at)
    SELECT k.tmdb_type,
      k.tmdb_id,
      COALESCE(k.name, (SELECT t.name FROM titles t WHERE t.tmdb_type = k.tmdb_type AND t.tmdb_id = k.tmdb_id), (SELECT s2.title FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.title IS NOT NULL AND TRIM(CAST(s2.title AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1)),
      (SELECT s2.overview FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.overview IS NOT NULL AND TRIM(CAST(s2.overview AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.poster_url FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.poster_url IS NOT NULL AND TRIM(CAST(s2.poster_url AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.backdrop_url FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.backdrop_url IS NOT NULL AND TRIM(CAST(s2.backdrop_url AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.network_logo_url FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.network_logo_url IS NOT NULL AND TRIM(CAST(s2.network_logo_url AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.tagline FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.tagline IS NOT NULL AND TRIM(CAST(s2.tagline AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.genres FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.genres IS NOT NULL AND TRIM(CAST(s2.genres AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.director FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.director IS NOT NULL AND TRIM(CAST(s2.director AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.director_imdb_id FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.director_imdb_id IS NOT NULL AND TRIM(CAST(s2.director_imdb_id AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.content_rating FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.content_rating IS NOT NULL AND TRIM(CAST(s2.content_rating AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.trailer_key FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.trailer_key IS NOT NULL AND TRIM(CAST(s2.trailer_key AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.runtime FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.runtime IS NOT NULL AND TRIM(CAST(s2.runtime AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.release_year FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.release_year IS NOT NULL AND TRIM(CAST(s2.release_year AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.rating FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.rating IS NOT NULL AND TRIM(CAST(s2.rating AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.tmdb_rating FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.tmdb_rating IS NOT NULL AND TRIM(CAST(s2.tmdb_rating AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.vote_count FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.vote_count IS NOT NULL AND TRIM(CAST(s2.vote_count AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.seasons_released FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.seasons_released IS NOT NULL AND TRIM(CAST(s2.seasons_released AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.episodes_released FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.episodes_released IS NOT NULL AND TRIM(CAST(s2.episodes_released AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.full_series FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.full_series IS NOT NULL AND TRIM(CAST(s2.full_series AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.next_season_date FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.next_season_date IS NOT NULL AND TRIM(CAST(s2.next_season_date AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.season_end_date FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.season_end_date IS NOT NULL AND TRIM(CAST(s2.season_end_date AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.streaming_on FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.streaming_on IS NOT NULL AND TRIM(CAST(s2.streaming_on AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.free_on FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.free_on IS NOT NULL AND TRIM(CAST(s2.free_on AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.studio FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.studio IS NOT NULL AND TRIM(CAST(s2.studio AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.original_language FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.original_language IS NOT NULL AND TRIM(CAST(s2.original_language AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.imdb_id FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.imdb_id IS NOT NULL AND TRIM(CAST(s2.imdb_id AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.tmdb_status FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.tmdb_status IS NOT NULL AND TRIM(CAST(s2.tmdb_status AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1),
      (SELECT s2.watch_link FROM shows s2
            WHERE s2.tmdb_id = k.tmdb_id
              AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
              AND s2.watch_link IS NOT NULL AND TRIM(CAST(s2.watch_link AS TEXT)) <> ''
            ORDER BY COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC LIMIT 1), datetime('now') FROM k WHERE true
    ON CONFLICT (tmdb_type, tmdb_id) DO UPDATE SET
      name = excluded.name,
      overview = excluded.overview,
      poster_url = excluded.poster_url,
      backdrop_url = excluded.backdrop_url,
      network_logo_url = excluded.network_logo_url,
      tagline = excluded.tagline,
      genres = excluded.genres,
      director = excluded.director,
      director_imdb_id = excluded.director_imdb_id,
      content_rating = excluded.content_rating,
      trailer_key = excluded.trailer_key,
      runtime = excluded.runtime,
      release_year = excluded.release_year,
      rating = excluded.rating,
      tmdb_rating = excluded.tmdb_rating,
      vote_count = excluded.vote_count,
      seasons_released = excluded.seasons_released,
      episodes_released = excluded.episodes_released,
      full_series = excluded.full_series,
      next_season_date = excluded.next_season_date,
      season_end_date = excluded.season_end_date,
      streaming_on = excluded.streaming_on,
      free_on = excluded.free_on,
      studio = excluded.studio,
      original_language = excluded.original_language,
      imdb_id = excluded.imdb_id,
      tmdb_status = excluded.tmdb_status,
      watch_link = excluded.watch_link,
      synced_at = excluded.synced_at;

WITH k AS (SELECT DISTINCT COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) AS tmdb_type, s.tmdb_id AS tmdb_id, NULL AS name
  FROM shows s WHERE s.tmdb_id IS NOT NULL),
    best AS (
      SELECT k.tmdb_type, k.tmdb_id,
        (SELECT s2.id FROM shows s2
          WHERE s2.tmdb_id = k.tmdb_id
            AND COALESCE(s2.tmdb_type, CASE WHEN s2.movie = 1 THEN 'movie' ELSE 'tv' END) = k.tmdb_type
          ORDER BY (SELECT COUNT(*) FROM actors a WHERE a.show_id = s2.id) DESC, COALESCE(s2.enriched_at, '') DESC, COALESCE(s2.updated_at, '') DESC, s2.id DESC
          LIMIT 1) AS show_id
      FROM k)
    INSERT INTO title_cast (tmdb_type, tmdb_id, ord, name, imdb_id, tmdb_person_id, character_name)
    SELECT best.tmdb_type, best.tmdb_id, COALESCE(a.ord, a.id), a.name, a.imdb_id, a.tmdb_person_id, a.character_name
      FROM best JOIN actors a ON a.show_id = best.show_id
     WHERE true
    ON CONFLICT (tmdb_type, tmdb_id, ord) DO NOTHING;
