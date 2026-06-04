-- Lets the vibe-admin "Re-score all" flow know which titles have been
-- refreshed in the current rescore pass. Cursor is the session's start
-- time; the server picks titles whose scored_at is null or older than
-- that, scores them, stamps datetime('now'), and the client stops when
-- nothing matches.

ALTER TABLE show_traits ADD COLUMN scored_at TEXT;
