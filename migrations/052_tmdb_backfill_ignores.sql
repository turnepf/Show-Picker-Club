-- Permanently dismissed titles for the TMDB-id backfill (mirrors
-- url_cleanup_ignores, migration 034/048). These two were checked by hand
-- and confirmed to have no TMDB entry at all, so they'd otherwise sit in
-- admin-tmdb-backfill's `unresolved` list forever.
--
-- NOTE: /api/admin-tmdb-backfill also creates this table on demand with the
-- identical statement, so deploy order doesn't matter.

CREATE TABLE IF NOT EXISTS tmdb_backfill_ignores (
  ltitle TEXT NOT NULL PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Dismissed 2026-07-24: confirmed absent from TMDB by hand (IMDB has both —
-- tt5792432 and tt7208956 respectively — but the app only has a TMDB-id
-- column, and there's no TMDB entry to point it at).
INSERT OR IGNORE INTO tmdb_backfill_ignores (ltitle) VALUES
  ('a pastor, a rabbi and an imam'),
  ('runescape: back in action');
