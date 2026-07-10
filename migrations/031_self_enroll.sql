-- Self-enrollment (2026-07). Anyone can create an account by verifying an
-- email code, or via Sign in with Apple / Google. New accounts get full
-- personal use immediately but start unapproved ("held"): hidden from the
-- home roster, vibe pages, cross-library search, activity, and trending
-- until the operator approves them from the /members admin page.

-- Existing members are approved; self-enrolled members start at 0.
ALTER TABLE members ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;

-- How the account came to exist: NULL for operator-created accounts,
-- else 'email' | 'apple' | 'google'.
ALTER TABLE members ADD COLUMN enrolled_via TEXT;

-- Google sign-in identity map (mirror of member_apple_ids, migration 011).
CREATE TABLE IF NOT EXISTS member_google_ids (
  google_sub TEXT PRIMARY KEY,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_member_google_ids_slug ON member_google_ids(member_slug);

-- Email-verification codes for enrollment. Unlike login_otps these are keyed
-- by email — no member row exists yet. A code is only consumed (used_at set)
-- when enrollment completes, so the verify → "pick your name" → complete
-- two-step works within the TTL.
CREATE TABLE IF NOT EXISTS enroll_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  ip TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enroll_otps_lookup ON enroll_otps(email, code, used_at);
CREATE INDEX IF NOT EXISTS idx_enroll_otps_created ON enroll_otps(created_at);
