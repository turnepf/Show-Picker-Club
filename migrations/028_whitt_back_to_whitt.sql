-- Whitt and Dorothy are two DIFFERENT people, not one person renamed.
-- Migration 026 mistakenly turned the 'whitt' record into a second "Dorothy":
-- same display name and the same login email (member@example.com) as the
-- real 'dorothy' member. That split her library and logins across two accounts
-- sharing one email. Restore the 'whitt' record to Whitt's own identity so the
-- two members are distinct again.
--
-- The slug stays 'whitt'. Idempotent: REPLACE + WHERE guards make re-runs no-ops.
--
-- Apply:
--   wrangler d1 execute shows-db --remote --file=migrations/028_whitt_back_to_whitt.sql

-- Display name + first name back to Whitt. 026 did REPLACE(name,'Whitt','Dorothy'),
-- so this exactly inverts it ("Dorothy Shuford's Shows" -> "Whitt Shuford's Shows").
UPDATE members
SET first_name = 'Whitt',
    name = REPLACE(name, 'Dorothy', 'Whitt')
WHERE slug = 'whitt';

-- Whitt's own login email (026 had repointed it at Dorothy's). This also
-- disambiguates the shared email: 'whitt' -> whitt@..., 'dorothy' keeps dorothy@...
UPDATE member_emails
SET email = 'member@example.com'
WHERE member_slug = 'whitt'
  AND email = 'member@example.com';

-- Whitt's phone (set originally in migration 001). Reassign it to 'whitt'
-- wherever it currently lives, and insert it if it's missing entirely.
UPDATE member_phones SET member_slug = 'whitt' WHERE phone = '+15555550100';
INSERT OR IGNORE INTO member_phones (phone, member_slug, label, is_primary)
VALUES ('+15555550100', 'whitt', NULL, 1);
