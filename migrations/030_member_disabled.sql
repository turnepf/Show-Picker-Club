-- Ban hammer for self-enroll: a disabled member keeps their rows but can't
-- log in, and every live session is refused at the gate (getSession checks
-- this flag). Toggled via /api/admin-member-disable, which also deletes the
-- member's sessions so the lockout is immediate.
ALTER TABLE members ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
