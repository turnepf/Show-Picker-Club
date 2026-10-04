-- The shared rows (migration 076) were built treating '' as missing. For
-- streaming_on, free_on and tmdb_status, '' is an answer: TMDB was asked and
-- named none. So 97 shows' streaming_on and 304 shows' free_on were left NULL
-- ("never asked") on 2026-10-04 while their copies held ''. Once the nightly
-- passes read gaps from the shared row (normalizing step 3c), each of those
-- would be re-fetched until the nightly rebuild filled it. This fills them
-- now, from the freshest copy with any value, '' included. Fill-only: a value
-- already on the shared row stays.
UPDATE titles SET streaming_on = (
    SELECT s.streaming_on FROM shows s
     WHERE s.tmdb_id = titles.tmdb_id
       AND COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) = titles.tmdb_type
       AND s.streaming_on IS NOT NULL
     ORDER BY COALESCE(s.enriched_at, '') DESC, s.id DESC LIMIT 1)
 WHERE streaming_on IS NULL;
UPDATE titles SET free_on = (
    SELECT s.free_on FROM shows s
     WHERE s.tmdb_id = titles.tmdb_id
       AND COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) = titles.tmdb_type
       AND s.free_on IS NOT NULL
     ORDER BY COALESCE(s.enriched_at, '') DESC, s.id DESC LIMIT 1)
 WHERE free_on IS NULL;
UPDATE titles SET tmdb_status = (
    SELECT s.tmdb_status FROM shows s
     WHERE s.tmdb_id = titles.tmdb_id
       AND COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) = titles.tmdb_type
       AND s.tmdb_status IS NOT NULL
     ORDER BY COALESCE(s.enriched_at, '') DESC, s.id DESC LIMIT 1)
 WHERE tmdb_status IS NULL;
