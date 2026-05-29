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
  ('bbennett@wildfireideas.com', 'brad', 1),
  ('bradunc90@gmail.com',        'brad', 0),
  ('bbennett31@icloud.com',      'brad', 0),
  ('mosss@wfu.edu',              'sherry', 1),
  ('abrownlee79@gmail.com',      'amy',    1),
  ('leonwestbrownlee@gmail.com', 'leon',   1),
  ('pbennett@wildfireideas.com', 'paula',  1),
  ('paulabennett0971@icloud.com','paula',  0),
  ('chuckbrownlee@gmail.com',    'chuck',  1),
  ('william@williamwturner.com',    'william', 1),
  ('williamwturner@icloud.com',     'william', 0),
  ('william@williamandfriends.com', 'william', 0),
  ('brownlee96@hotmail.com',     'kirsten',1),
  ('anniekate2002@gmail.com',    'annie',    1),
  ('fiona@fionaturner.com',          'fiona',    1),
  ('fionturn@icloud.com',            'fiona',    0),
  ('jennifer.gowen@gmail.com',       'jennifer', 1),
  ('biggsjm2@gmail.com',             'jennifer', 0),
  ('jessicaryan_98@yahoo.com',       'jessica',  1),
  ('joepotterwsnc@gmail.com',        'joe',      1),
  ('josephlbrooks@gmail.com',        'joey',     1),
  ('countymayor@claibornecountytn.gov','joey',   0),
  ('hillbillyvol@hotmail.com',       'joey',     0),
  ('kellyballwolf@gmail.com',        'kelly',    1),
  ('laurinpotter0304@gmail.com',     'laurin',   1),
  ('mb@twelvelife.com',              'mb',       1),
  ('marybethbarrett70@gmail.com',    'mb',       0),
  ('mb@addressingspaces.com',        'mb',       0),
  ('suemo214@gmail.com',             'susan',    1),
  ('susan_c_morris@yahoo.com',       'susan',    0),
  ('victoriashamblin@gmail.com',     'tori',     1),
  ('whitt@whittshuford.com',         'whitt',    1);

-- Backfill mobile numbers for any members missing one. INSERT OR IGNORE
-- with the (phone, member_slug) UNIQUE means we never duplicate, and
-- is_primary stays 0 so we don't disturb an existing primary.
INSERT OR IGNORE INTO member_phones (phone, member_slug, is_primary) VALUES
  ('+13366710845', 'brad',   0),
  ('+13364064844', 'sherry', 0),
  ('+19015965063', 'amy',    0),
  ('+18043809863', 'leon',   0),
  ('+13367495420', 'paula',  0),
  ('+19012701198', 'chuck',  0),
  ('+13363917054', 'william',0),
  ('+15082452334', 'kirsten',0),
  ('+13367822002', 'annie',  0),
  ('+19196329667', 'carter', 0),
  ('+13363145209', 'kelly',  0),
  ('+13363063084', 'laurin', 0),
  ('+13364067072', 'mb',     0),
  ('+13364078742', 'susan',  0),
  ('+13046716999', 'tori',   0),
  ('+14235267777', 'whitt',  0);
