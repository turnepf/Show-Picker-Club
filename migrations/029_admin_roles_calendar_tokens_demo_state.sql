-- Security hardening (2026-07):
--
-- 1. Database-backed admin role. Admin checks used to compare the session's
--    member_slug against a hardcoded ADMIN_SLUG constant in source. Permissions
--    belong in the database: members.is_admin, seeded for the operator.
--
-- 2. Calendar feed tokens. /calendar/<slug>.ics used to be readable by anyone
--    who could guess a member slug. Each member gets a random token; the feed
--    now requires ?key=<calendar_token>.
--
-- 3. demo_state: small key/value table backing the demo-account auto-reset
--    (baseline snapshot + when the next reset is due).

ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
UPDATE members SET is_admin = 1 WHERE slug = 'patrick';

ALTER TABLE members ADD COLUMN calendar_token TEXT;
UPDATE members SET calendar_token = lower(hex(randomblob(16))) WHERE calendar_token IS NULL;

CREATE TABLE IF NOT EXISTS demo_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
