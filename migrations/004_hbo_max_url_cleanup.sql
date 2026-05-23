-- HBO Max URL hygiene.
--
-- Note: NOT translating www.max.com or www.hbomax.com info-page URLs to
-- play.hbomax.com. Those hosts use SEO slugs (/shows/curb-your-enthusiasm)
-- while play.hbomax.com uses hashed content IDs (/show/abc123/...). A blind
-- host swap would 404 every show. The info-page URLs still resolve to a
-- valid HBO Max page that links into the streaming app, so they stay.
--
-- This migration only fixes the rows where a URL from a different service
-- got tagged as HBO Max — the URL-domain wins, the network field updates
-- to match. Mirrors the runtime rule in functions/_shared/networks.js.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/004_hbo_max_url_cleanup.sql

UPDATE shows
  SET network = 'Hulu'
WHERE network = 'HBO Max'
  AND network_url LIKE 'https://%hulu.com/%';

UPDATE shows
  SET network = 'AMC+'
WHERE network = 'HBO Max'
  AND network_url LIKE 'https://%amcplus.com/%';
