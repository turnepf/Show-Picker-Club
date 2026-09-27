-- A per-member daily ledger of the upstream calls a member's requests cost:
-- Claude (list import), TMDB/Watchmode enrichment fan-outs (add, edit,
-- suggest), and TMDB type-ahead searches. Charged by _shared/spend-meter.js.
--
-- Until now the only ceilings on that spend were counted from `shows` rows —
-- 50 adds a day, 300 imported rows a day — which bounds the paths that write
-- a row and nothing else. An edit, a duplicate add answered 409, the suggest
-- proxy, the type-ahead search and the import's parse step all spend on
-- operator-held keys without inserting anything, so no row count ever saw
-- them. Signup is open and self-service, so "has a session" is not a budget.
--
-- One row per member per UTC day, same shape as mcp_usage (migration 071).
-- Pruned after a week by backup.yml; nothing reads past today.
CREATE TABLE IF NOT EXISTS member_spend (
  member_slug TEXT NOT NULL,
  day TEXT NOT NULL,
  claude INTEGER NOT NULL DEFAULT 0,
  lookups INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_slug, day)
);
