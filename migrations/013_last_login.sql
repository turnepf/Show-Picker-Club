-- Durable per-member login tracking. The sessions table can't answer
-- "who has never logged in" because logout deletes the session row, so add a
-- column that's set on every successful login and never cleared.
ALTER TABLE members ADD COLUMN last_login_at TEXT;

-- Best-effort backfill from any session that still exists. Logout deletes
-- session rows, so this only catches members with a live session — but it's
-- better than starting everyone at NULL.
UPDATE members
   SET last_login_at = (
     SELECT MAX(s.created_at) FROM sessions s WHERE s.member_slug = members.slug
   )
 WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.member_slug = members.slug);
