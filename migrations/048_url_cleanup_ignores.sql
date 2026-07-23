-- Operator-dismissed titles for the Show Cleanup queue (mirrors dupe_ignores,
-- migration 034). Some titles genuinely have no good deep link — a real
-- placeholder- or search-only situation, not a fixable data gap — so they'd
-- otherwise sit in the queue forever. A dismissal has to stick.
--
-- NOTE: /api/admin-url-cleanup also creates this table on demand with the
-- identical statement, so deploy order doesn't matter — this migration
-- exists for the schema record and fresh-instance setup.

CREATE TABLE IF NOT EXISTS url_cleanup_ignores (
  ltitle TEXT NOT NULL PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Dismiss "A Pastor, a Rabbi and an Imam" (2026-07): the title is ambiguous
-- enough (a generic joke-format name, not a specific indexed show) that no
-- direct streaming deep link exists to paste. Matched by LIKE rather than an
-- exact string since punctuation/casing can vary across members' copies.
INSERT OR IGNORE INTO url_cleanup_ignores (ltitle)
SELECT DISTINCT LOWER(title) FROM shows
WHERE LOWER(title) LIKE '%pastor%rabbi%imam%' AND archived = 0;
