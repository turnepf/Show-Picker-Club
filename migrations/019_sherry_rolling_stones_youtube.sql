-- Move Sherry's "The Rolling Stones Chronicles" from Netflix to YouTube.
-- YouTube was just added to the canonical network list
-- (functions/_shared/networks.js); this reassigns the one existing show that
-- actually streams there.
--
-- The old Netflix deep link is wrong for the new service, so replace it with a
-- YouTube search URL built from the row's own title (encoding spaces as '+') —
-- matching what generateNetworkUrl() would produce for the YouTube search base,
-- and avoiding any title-spelling mismatch.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/019_sherry_rolling_stones_youtube.sql
--
-- Scoped to Sherry's Netflix row so it's a no-op on re-run (network is no
-- longer 'Netflix' after the first pass).

UPDATE shows
SET network = 'YouTube',
    network_url = 'https://www.youtube.com/results?search_query=' || REPLACE(title, ' ', '+')
WHERE member_slug = 'sherry'
  AND title LIKE '%Rolling Stones%'
  AND network = 'Netflix';
