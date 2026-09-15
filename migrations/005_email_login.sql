-- Email-based login: per-member emails + ephemeral one-time codes.
-- Coexists with the legacy static codes in member_codes for a transition
-- period; /auth/login accepts either. After the rollout settles we can
-- drop the static-code path.

CREATE TABLE IF NOT EXISTS member_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (email, member_slug)
);
CREATE INDEX IF NOT EXISTS idx_member_emails_email ON member_emails(email);
CREATE INDEX IF NOT EXISTS idx_member_emails_slug  ON member_emails(member_slug);

-- One-time login codes. Channel records how it was delivered (email today,
-- sms once Twilio approves). Expire fast; one-shot use.
CREATE TABLE IF NOT EXISTS login_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  code TEXT NOT NULL,
  channel TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_otps_lookup  ON login_otps(member_slug, code, used_at);
CREATE INDEX IF NOT EXISTS idx_login_otps_expires ON login_otps(expires_at);

-- This file originally also seeded existing members' email addresses and
-- backfilled their phone numbers. That data was applied to production once
-- and now lives only in the database (member_emails, member_phones); it was
-- removed from the repo so members' contact details aren't kept in source
-- control.
