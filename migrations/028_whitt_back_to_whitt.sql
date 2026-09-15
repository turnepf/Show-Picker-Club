-- Whitt and Dorothy are two DIFFERENT people, not one person renamed.
-- Migration 026 mistakenly turned the 'whitt' record into a second "Dorothy":
-- same display name and the same login email as the
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

-- The rest of this migration restored Whitt's own login email and phone
-- number in member_emails / member_phones. It was applied to production once;
-- the address and number were removed from the repo so members' contact
-- details aren't kept in source control.
