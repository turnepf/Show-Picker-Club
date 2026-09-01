-- Trending becomes a daily snapshot (2026-09-01 D1 outage).
--
-- /api/popular's ranking query title-matches copies across the whole shows
-- table with correlated subqueries, and the endpoint is public — so every
-- uncached hit paid a near-full-table scan several times over. Bots hammering
-- the public surface burned the entire free-tier daily rows_read budget and
-- took the API down for everyone. The endpoint now computes the ranking once
-- per UTC day and serves everybody else from this one-row cache.
CREATE TABLE IF NOT EXISTS trending_cache (
  day TEXT PRIMARY KEY,              -- UTC date, YYYY-MM-DD
  payload TEXT NOT NULL,             -- JSON array of ranked show rows
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The daily compute (and every other LOWER(title)-matched lookup) gets an
-- expression index so each title match is a seek instead of a table scan.
-- idx_shows_active_title is COLLATE NOCASE and doesn't serve LOWER() queries.
CREATE INDEX IF NOT EXISTS idx_shows_title_lower ON shows(LOWER(title));
