-- Phone numbers for SMS-based login (replaces 4-digit codes) and recommendation alerts.
--
-- A many-to-many between phones and members:
--   * One member can have multiple phones (Fiona's US + UK; spouse who wants
--     to log in as themselves too).
--   * One phone can authenticate to multiple members (spouse who also helps
--     manage their partner's list — e.g., Ali → Patrick).
--
-- Each member has exactly one primary phone (is_primary = 1). That's where
-- recommendation alerts and other notifications go. Login can use any phone
-- on file; primary is purely for outbound messaging.
--
-- Login flow this enables:
--   1. User enters their phone number.
--   2. We send an SMS code to that phone.
--   3. After entering the code, we look up every member_phones row for that
--      phone. If one match, log in as that member. If multiple, ask which
--      one to log in as.
--   4. Login is only needed for editing — anyone can browse without it.
--
-- Apply with:
--   wrangler d1 execute shows-db --remote --file=migrations/001_add_phone.sql
--
-- NOTE: If an earlier version of this file added a `phone` column directly
-- to members, drop it after running:
--   wrangler d1 execute shows-db --remote --command "ALTER TABLE members DROP COLUMN phone"
--   wrangler d1 execute shows-db --remote --command "DROP INDEX IF EXISTS idx_members_phone"

CREATE TABLE IF NOT EXISTS member_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  label TEXT,                                       -- 'Ali', 'UK', etc; optional
  is_primary INTEGER NOT NULL DEFAULT 0,            -- exactly one per member should be 1
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (phone, member_slug)
);

CREATE INDEX IF NOT EXISTS idx_member_phones_phone ON member_phones(phone);
CREATE INDEX IF NOT EXISTS idx_member_phones_slug  ON member_phones(member_slug);
-- Enforce one-primary-per-member at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_phones_primary
  ON member_phones(member_slug) WHERE is_primary = 1;

-- This file originally also seeded the first members' phone numbers. That
-- data was applied to production once and now lives only in the database
-- (member_phones); it was removed from the repo so members' contact details
-- aren't kept in source control.
