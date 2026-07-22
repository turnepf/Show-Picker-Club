-- Durable per-member platform usage. sessions.platform (migration 016) only
-- reflects the current live session and is deleted on logout/disable, so it
-- can't answer "what platforms has this member ever used from" -- this
-- table can. Stamped by _shared/auth.js#getSession() (every authenticated
-- API call) and auth/check.js whenever a request carries a recognized
-- X-Client-Platform header. Shown on the Manage Members admin page.
CREATE TABLE IF NOT EXISTS member_platforms (
  member_slug TEXT NOT NULL,
  platform TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (member_slug, platform)
);
