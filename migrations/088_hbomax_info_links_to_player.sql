-- HBO Max info-page links (www.hbomax.com / www.max.com) open the HBO Max
-- home screen rather than the show, so the URL-cleanup queue and the nightly
-- Watchmode fill count them as placeholders. They carry the player's id, so
-- each is moved onto play.hbomax.com — the same rewrite normalizeHboMaxUrl()
-- in functions/_shared/hbomax-urls.js now applies on every save. Rows only,
-- no schema change; updated_at is left alone (this is not a member edit).
-- A link whose path doesn't end in a show/movie id is left as it was.
UPDATE shows
   SET network_url = 'https://play.hbomax.com/'
         || CASE WHEN r.bare LIKE '%/movie/%' OR r.bare LIKE '%/movies/%' THEN 'movie' ELSE 'show' END
         || '/' || lower(substr(r.bare, -36))
  FROM (SELECT id,
               rtrim(CASE WHEN instr(network_url, '?') > 0
                          THEN substr(network_url, 1, instr(network_url, '?') - 1)
                          ELSE network_url END, '/') AS bare
          FROM shows
         WHERE network_url LIKE 'https://www.hbomax.com/%'
            OR network_url LIKE 'https://hbomax.com/%'
            OR network_url LIKE 'https://www.max.com/%'
            OR network_url LIKE 'https://max.com/%') AS r
 WHERE shows.id = r.id
   AND (r.bare LIKE '%/show/%' OR r.bare LIKE '%/shows/%'
        OR r.bare LIKE '%/movie/%' OR r.bare LIKE '%/movies/%')
   AND substr(r.bare, -37, 1) = '/'
   -- The id: 36 characters, dashes where a UUID has them, nothing but hex
   -- and dashes. D1 caps a GLOB pattern's length, so this is checked piece
   -- by piece rather than as one 36-position pattern.
   AND substr(r.bare, -36, 1) != '-'
   AND substr(r.bare, -28, 1) = '-'
   AND substr(r.bare, -23, 1) = '-'
   AND substr(r.bare, -18, 1) = '-'
   AND substr(r.bare, -13, 1) = '-'
   AND lower(substr(r.bare, -36)) NOT GLOB '*[^0-9a-f-]*';
