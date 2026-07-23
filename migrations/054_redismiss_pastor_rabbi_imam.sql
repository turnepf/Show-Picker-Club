-- "A Pastor, a Rabbi and an Imam" resurfaced in the Show Cleanup queue after
-- migration 048 already dismissed it once. That dismissal was a one-time
-- snapshot of whatever title text existed then — most likely a fresh copy
-- was added by some member afterward, and since url_cleanup_ignores matches
-- by exact title string, a new row isn't automatically covered by the old
-- dismissal. Same underlying reasoning as 048: the title is ambiguous
-- enough (a generic joke-format name) that no direct streaming deep link
-- exists to paste. Re-run against current data rather than assuming
-- nothing's changed since; no archived filter this time since dismissing a
-- title string is harmless for archived rows (the queue itself already
-- filters archived = 0).

INSERT OR IGNORE INTO url_cleanup_ignores (ltitle)
SELECT DISTINCT LOWER(title) FROM shows
WHERE LOWER(title) LIKE '%pastor%rabbi%imam%';
