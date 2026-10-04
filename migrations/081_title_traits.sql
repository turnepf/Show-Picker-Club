-- Vibe fingerprints keyed by show, not by title (docs/INVARIANTS.md §17).
-- show_traits is keyed by LOWER(title), so every show sharing a name shared
-- one fingerprint: three 2026 films are called "The Odyssey". title_traits
-- keys a fingerprint by TMDB entry, the way the rest of the app now decides
-- "same show" (functions/_shared/same-show.js).
--
-- Backfill: a scored title whose copies all point at one show carries its
-- fingerprint to that show's key. A title whose copies point at more than
-- one show is left unscored, so the fill queue scores each show on its own
-- (with its year and overview) instead of handing one show's score to the
-- others. On 2026-10-04 that was none of the 518 live scored titles; the 124
-- titles no library holds any more aren't carried.
--
-- Additive: show_traits stays in place, unread, until a later cleanup.
CREATE TABLE IF NOT EXISTS title_traits (
  -- The show this fingerprint describes: 'tv:<tmdb_id>' / 'movie:<tmdb_id>',
  -- or 'title:<lowercased title>' for a show TMDB never matched. The same
  -- key as showKeySql() in functions/_shared/same-show.js.
  show_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  warmth REAL, empathy REAL, emotional_repair REAL, moral_ambiguity REAL,
  darkness REAL, cynicism REAL, manipulation REAL, power_orientation REAL,
  chaos_intensity REAL, humor_warmth REAL, cruel_humor REAL,
  intellectual_curiosity REAL, growth_orientation REAL, violence_intensity REAL,
  comfort_coziness REAL, community_belonging REAL, satire REAL,
  prestige_energy REAL, emotional_volatility REAL, healing_redemption REAL,
  revenge_energy REAL, status_obsession REAL, optimism REAL, nihilism REAL,
  teamwork REAL, absurdism REAL,
  unknown_show INTEGER DEFAULT 0,
  generated_at TEXT DEFAULT (datetime('now')),
  scored_at TEXT
);

INSERT OR IGNORE INTO title_traits (show_key, title, warmth, empathy, emotional_repair, moral_ambiguity, darkness, cynicism, manipulation, power_orientation, chaos_intensity, humor_warmth, cruel_humor, intellectual_curiosity, growth_orientation, violence_intensity, comfort_coziness, community_belonging, satire, prestige_energy, emotional_volatility, healing_redemption, revenge_energy, status_obsession, optimism, nihilism, teamwork, absurdism, unknown_show, generated_at, scored_at)
SELECT k.show_key, t.title, t.warmth, t.empathy, t.emotional_repair, t.moral_ambiguity, t.darkness, t.cynicism, t.manipulation, t.power_orientation, t.chaos_intensity, t.humor_warmth, t.cruel_humor, t.intellectual_curiosity, t.growth_orientation, t.violence_intensity, t.comfort_coziness, t.community_belonging, t.satire, t.prestige_energy, t.emotional_volatility, t.healing_redemption, t.revenge_energy, t.status_obsession, t.optimism, t.nihilism, t.teamwork, t.absurdism, t.unknown_show, t.generated_at, t.scored_at
  FROM show_traits t
  JOIN (SELECT DISTINCT LOWER(s.title) AS tl,
      CASE WHEN s.tmdb_id IS NOT NULL THEN COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) || ':' || s.tmdb_id
      ELSE 'title:' || LOWER(TRIM(s.title)) END AS show_key
      FROM shows_v s) k ON k.tl = t.title_lower
 WHERE (SELECT COUNT(DISTINCT CASE WHEN x.tmdb_id IS NOT NULL THEN COALESCE(x.tmdb_type, CASE WHEN x.movie = 1 THEN 'movie' ELSE 'tv' END) || ':' || x.tmdb_id
      ELSE 'title:' || LOWER(TRIM(x.title)) END)
          FROM shows_v x WHERE LOWER(x.title) = t.title_lower) = 1;
