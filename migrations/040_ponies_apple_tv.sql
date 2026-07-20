-- "Ponies" is real — the 2026 Apple TV+ Cold War spy drama (Emilia Clarke),
-- one of the three titles the off-platform import (032) left unresolved. It
-- came in with no network, so it never got a real watch URL, and it's still
-- missing a poster. TMDB does carry it (themoviedb.org/tv/262793-ponies), so a
-- re-enrich should attach the poster.
--
-- Set the canonical network and the real Apple TV deep link Patrick supplied
-- (a genuine per-show URL, not a /search placeholder, so the frontend, calendar
-- feed, and sync-urls all treat it as a real link). Clear enriched_at so the
-- poster backfills on the next enrich run. poster_url is left as-is (COALESCE
-- keeps any existing artwork); updated_at is untouched (member-intent only).
--
-- Title-scoped so it covers every member's copy. Network URL is only set where
-- it's still a placeholder/NULL, so a member who already pasted their own real
-- link keeps it.
--
-- Applied automatically by the next deploy (scripts/apply-migrations.sh), or
-- by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/040_ponies_apple_tv.sql

UPDATE shows
SET network = 'Apple TV+',
    network_url = CASE
      WHEN network_url IS NULL
        OR network_url LIKE '%/search%'
        OR network_url LIKE '%/s?%'
        OR network_url LIKE '%?q=%'
        OR network_url LIKE '%?query=%'
      THEN 'https://tv.apple.com/us/show/ponies/umc.cmc.178c2tx1wzzle9d5gtoy6uvaw'
      ELSE network_url
    END,
    enriched_at = NULL
WHERE LOWER(title) = 'ponies'
  AND archived = 0;
