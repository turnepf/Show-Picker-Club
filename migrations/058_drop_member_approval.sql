-- Retire member approval and operator-created members (2026-08).
--
-- Every account is self-enrolled now: enrolling IS being a member. The
-- "held" state (members.approved = 0) that hid a new account from the
-- roster, vibe, cross-library search, activity, and trending is gone, and
-- so is the whole operator queue that fed it — /join requests, the
-- approve/reject workflow, and manual member creation.

-- The roster hold. Nothing reads it any more.
ALTER TABLE members DROP COLUMN approved;

-- Per-IP enrollment throttling used to count rows in signup_requests. With
-- that table gone the members row carries its own origin IP instead, which
-- also means a member deleting their account takes the IP with it (the old
-- audit row survived deletion with its PII scrubbed).
ALTER TABLE members ADD COLUMN enroll_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_members_enroll_ip ON members(enroll_ip, created_at);

-- The operator approval queue: /join submissions plus self-enroll audit
-- rows. No endpoint reads or writes it after this release.
DROP INDEX IF EXISTS idx_signup_requests_status;
DROP INDEX IF EXISTS idx_signup_requests_created;
DROP TABLE IF EXISTS signup_requests;
