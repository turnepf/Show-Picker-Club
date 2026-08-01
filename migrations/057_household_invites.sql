-- Household invites: invite-code-based household membership (like groups)
-- Allows members to invite others to their household without exposing full roster.

CREATE TABLE IF NOT EXISTS household_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_slug TEXT NOT NULL REFERENCES members(slug) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_household_invites_code ON household_invites(code);
CREATE INDEX IF NOT EXISTS idx_household_invites_inviter ON household_invites(inviter_slug);
