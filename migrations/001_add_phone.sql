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

-- Seed numbers below. E.164 format (+CC...) so they're ready to hand to a
-- sending API. Multiple rows per member if they have multiple numbers; one
-- row per (phone, member) authorization grant. is_primary = 1 marks the
-- phone we send outbound notifications to.

INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13366927470', 'patrick', NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+19015965063', 'amy',     NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+19012701198', 'chuck',   NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13366925949', 'fiona',   'US', 0);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+447402422823','fiona',   'UK', 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13369781406', 'jennifer',NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+19012322536', 'jessica', NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13369780657', 'joe',     NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+18658983592', 'joey',    NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13367829131', 'kathleen',NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13363145209', 'kelly',   NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13362519442', 'kevin',   NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+15082452334', 'kirsten', NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13363063084', 'laurin',  NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+18043809863', 'leon',    NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13362874140', 'lisa',    NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13364067072', 'mb',      NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13367495420', 'paula',   NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13364064844', 'sherry',  NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13364078742', 'susan',   NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13046716999', 'tori',    NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+14235267777', 'whitt',   NULL, 1);
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary) VALUES ('+13363917054', 'william', NULL, 1);
