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

-- Seed known emails for existing members. Primary is the address most
-- likely to be checked; alternates are kept so a code request to any one
-- of them still works.
INSERT OR IGNORE INTO member_emails (email, member_slug, is_primary) VALUES
  ('patrick@patrickturner.net', 'patrick', 1),
  ('member@example.com', 'brad', 1),
  ('member@example.com',        'brad', 0),
  ('member@example.com',      'brad', 0),
  ('member@example.com',              'sherry', 1),
  ('member@example.com',      'amy',    1),
  ('member@example.com', 'leon',   1),
  ('member@example.com', 'paula',  1),
  ('member@example.com','paula',  0),
  ('member@example.com',    'chuck',  1),
  ('member@example.com',    'william', 1),
  ('member@example.com',     'william', 0),
  ('member@example.com', 'william', 0),
  ('member@example.com',     'kirsten',1),
  ('member@example.com',    'annie',  1);

-- Backfill mobile numbers for any members missing one. INSERT OR IGNORE
-- with the (phone, member_slug) UNIQUE means we never duplicate, and
-- is_primary stays 0 so we don't disturb an existing primary.
INSERT OR IGNORE INTO member_phones (phone, member_slug, is_primary) VALUES
  ('+15555550100', 'brad',   0),
  ('+15555550100', 'sherry', 0),
  ('+15555550100', 'amy',    0),
  ('+15555550100', 'leon',   0),
  ('+15555550100', 'paula',  0),
  ('+15555550100', 'chuck',  0),
  ('+15555550100', 'william',0),
  ('+15555550100', 'kirsten',0),
  ('+15555550100', 'annie',  0),
  ('+15555550100', 'carter', 0);
