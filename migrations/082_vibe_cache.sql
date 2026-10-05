-- The vibe page's club-wide numbers, cached for a week.
--
-- Every /api/vibe view joined every member's whole library to title_traits
-- to rebuild each member's fingerprint: the club baseline a member is read
-- against, and the group-mates' personas the variety rule hands out. Those
-- move slowly, and Patrick chose weekly (2026-10-04). The viewer's own
-- fingerprint stays live; this holds everyone else's plus the baseline.
-- Same shape and fall-through as trending_cache (migration 067): a missing,
-- stale or corrupt row recomputes instead of erroring.
CREATE TABLE IF NOT EXISTS vibe_cache (
  key TEXT PRIMARY KEY,               -- 'club'
  payload TEXT NOT NULL,              -- JSON {fingerprints, scored, baseline}
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
