-- Household members for the subscription audit: each member keeps their own
-- list of other club members they share streaming services with, so the audit
-- can pool everyone in the household's shows when deciding keep/pause/cancel.
--
-- Directed and per-member: member_slug's household includes other_slug. A adds
-- B to A's household without changing B's own audit. Rows are cleaned up by the
-- member re-saving their household selection (the endpoint replaces the set).
--
-- Apply with (note the migrations/ path prefix):
--   wrangler d1 execute shows-db --remote --file=migrations/045_household_members.sql

CREATE TABLE IF NOT EXISTS household_members (
  member_slug TEXT NOT NULL,
  other_slug  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (member_slug, other_slug)
);

CREATE INDEX IF NOT EXISTS idx_household_member ON household_members(member_slug);
