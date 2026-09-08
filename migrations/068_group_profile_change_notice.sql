-- Renaming a group and changing its icon (migration 066) stop being
-- creator-only: Patrick hit this as a group he was in but hadn't created,
-- where the option simply wasn't there. Any group member may now do both.
--
-- To keep a silent takeover-by-editing from being confusing, whoever else is
-- in the group gets told once: `groups` remembers who last touched the
-- name/icon and what they touched, `group_members` remembers each member's
-- own high-water mark against it, so `GET /api/groups/[id]` can show "X
-- renamed the group" exactly once per member per change and never to the
-- member who made it.
ALTER TABLE groups ADD COLUMN profile_changed_by TEXT REFERENCES members(slug);
ALTER TABLE groups ADD COLUMN profile_changed_at TEXT;
ALTER TABLE groups ADD COLUMN profile_changed_fields TEXT;
ALTER TABLE group_members ADD COLUMN last_seen_change_at TEXT;
