-- Add a full last_name column so we stop parsing it out of members.name
-- (which is the possessive "Carter's Shows" display string) or making do
-- with just last_initial. last_initial stays around to avoid breaking
-- callers; new code should prefer last_name.

-- ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite. Run this once.
-- (Already applied to prod 2026-06-03 — see UPDATEs below.)
-- ALTER TABLE members ADD COLUMN last_name TEXT;

-- The backfill of existing members' last names that followed here named
-- real members and was removed when the repository went public. It ran on
-- 2026-06-03 and is tracked by filename, so it is never re-run.
