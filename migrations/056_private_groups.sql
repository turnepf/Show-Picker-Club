-- Add private groups support
-- Users can create groups, invite members via links, and share group-specific trending

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  creator_slug TEXT NOT NULL REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, member_slug)
);

CREATE TABLE IF NOT EXISTS group_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(slug),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_slug);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_slug);
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_token ON group_invites(token);
CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at);
