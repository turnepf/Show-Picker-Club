-- Sign in with Apple: link an Apple user id (the token `sub`) to an existing
-- member. We still map the *first* sign-in by the email Apple shares (against
-- member_emails), then remember the stable `sub` so later sign-ins keep working
-- even if the user hides their email behind a private-relay address. No public
-- sign-up — this only ever links to members the operator already seeded.

CREATE TABLE IF NOT EXISTS member_apple_ids (
  apple_sub   TEXT PRIMARY KEY,
  member_slug TEXT NOT NULL REFERENCES members(slug),
  email       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_member_apple_ids_slug ON member_apple_ids(member_slug);
