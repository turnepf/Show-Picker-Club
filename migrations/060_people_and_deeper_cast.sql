-- Canonical people: one row per human, not one per (show, human).
--
-- `actors` stores a name + imdb_id per show copy, so the same person appearing
-- on five shows was five independent rows — and if one show's enrichment
-- resolved an IMDB id while another's didn't, the second stayed an unlinked
-- plain name forever. Nothing consulted what we already knew. This table is
-- what we already know, and it means a cast member we've seen before costs no
-- TMDB request at all.
CREATE TABLE IF NOT EXISTS people (
  -- TMDB's person id: stable, and what enrichment already has in hand.
  tmdb_person_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Lowercased name for the by-name path: creators are stored on shows as
  -- text (no id), and legacy actor rows only ever had a name.
  name_lower TEXT NOT NULL,
  imdb_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_name_lower ON people(name_lower);

-- People we know by name but not by TMDB id (legacy actor rows, creators
-- resolved before this table existed). Keyed on the lowercased name so the
-- fill-from-what-we-know pass can find them.
CREATE TABLE IF NOT EXISTS people_by_name (
  name_lower TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Billing order (TMDB's `order`, 0 = top-billed) and the person id, so a
-- cast list can be shown deepest-first-N consistently and linked without a
-- name match. NULL on rows written before this migration.
ALTER TABLE actors ADD COLUMN ord INTEGER;
ALTER TABLE actors ADD COLUMN tmdb_person_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_actors_show_ord ON actors(show_id, ord);
