-- Fold sub-brand network names into their canonical streaming-service brand
-- so the dropdown, search URL templates, and member-facing labels can all
-- agree on a single representation. See functions/_shared/networks.js for
-- the canonical list.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/002_consolidate_networks.sql
--
-- Safe to re-run — each UPDATE only matches rows still on the old value.

UPDATE shows SET network = 'Max'                WHERE network IN ('HBO', 'HBO Max', 'Discovery', 'Discovery+', 'Cartoon Network', 'Adult Swim', 'TNT', 'TBS', 'truTV', 'CNN');
UPDATE shows SET network = 'Apple TV+'          WHERE network IN ('Apple TV', 'AppleTV+', 'AppleTV');
UPDATE shows SET network = 'Hulu'               WHERE network IN ('FX', 'FXX', 'ABC', 'National Geographic', 'Nat Geo', 'Freeform');
UPDATE shows SET network = 'Paramount+'         WHERE network IN ('Paramount', 'CBS', 'MTV', 'Comedy Central', 'Nickelodeon', 'BET', 'Showtime', 'Smithsonian Channel');
UPDATE shows SET network = 'Peacock'            WHERE network IN ('NBC', 'Bravo', 'USA', 'USA Network', 'Syfy', 'SyFy', 'Oxygen', 'E!');
UPDATE shows SET network = 'Amazon Prime Video' WHERE network IN ('Amazon', 'Amazon Prime', 'Prime Video', 'MGM+', 'MGM', 'Freevee', 'IMDb TV');
UPDATE shows SET network = 'Disney+'            WHERE network IN ('Disney', 'Marvel', 'Star Wars', 'Pixar');
UPDATE shows SET network = 'AMC+'               WHERE network IN ('AMC', 'BBC America', 'IFC', 'Sundance', 'Shudder');

-- Network URLs pointing at the *old* network's search page should be cleared
-- so subsequent /api/sync-urls + /url-cleanup runs can repopulate them from
-- a sibling row that has the right deep link.
UPDATE shows SET network_url = NULL
WHERE network_url LIKE '%hbo.com/search%'
   OR network_url LIKE '%hbomax.com/search%'
   OR network_url LIKE '%nbc.com/search%'
   OR network_url LIKE '%sho.com/search%'
   OR network_url LIKE '%showtime.com/search%'
   OR network_url LIKE '%abc.com/search%'
   OR network_url LIKE '%fox.com/search%'
   OR network_url LIKE '%cbs.com/search%'
   OR network_url LIKE '%amc.com/search%'
   OR network_url LIKE '%bravo.com/search%';
