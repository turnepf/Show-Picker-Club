-- Every change an admin makes to another member's lists through a connected
-- AI app (the members:admin scope, docs/INVARIANTS.md §27). One row per
-- change: who did it, whose list it touched, which tool, and the arguments.
-- No foreign keys on purpose — the record outlives a deleted member.
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_slug TEXT NOT NULL,
  member_slug TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_member ON admin_actions(member_slug, created_at);
