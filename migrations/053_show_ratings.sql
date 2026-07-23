-- Member ratings (docs/PRODUCT.md backlog: "Member ratings"). Keyed off
-- (tmdb_id, tmdb_type) rather than any one member's `shows` row, so every
-- member's independent copy of the same title shares one rating pool —
-- that's the whole reason migration 049 added tmdb_id/tmdb_type to `shows`.
--
-- season_number 0 means the overall rating; 1+ is that season, matching
-- `seasons_released`'s numbering (which starts at 1). A sentinel (not NULL)
-- because SQLite's UNIQUE constraint treats every NULL as distinct from
-- every other NULL, so a NULL-based "one overall rating per member" rule
-- wouldn't actually be enforced by the constraint below.

CREATE TABLE show_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  tmdb_type TEXT NOT NULL,
  season_number INTEGER NOT NULL DEFAULT 0,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (tmdb_id, tmdb_type, season_number, member_slug)
);

CREATE INDEX idx_show_ratings_title ON show_ratings (tmdb_id, tmdb_type);
