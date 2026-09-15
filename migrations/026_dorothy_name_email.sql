-- Whitt now goes by Dorothy: change her display name and login email.
--
-- The slug stays 'whitt' — URLs, shows.member_slug, member_emails/phones,
-- and the existing /dorothy → /whitt 301 all keep working untouched. Only
-- what renders on screen ("Dorothy's Shows") and the address login codes
-- go to change.
--
-- first_name is set explicitly because every display path prefers it over
-- name's first token (members.js, popular.js, calendar). name is updated
-- with REPLACE so it works whatever the exact stored value is ('Whitt',
-- 'Whitt Shuford', ...) and stays a no-op on re-run.
--
-- The email UPDATE is scoped to the old address so any other addresses on
-- file are untouched; is_primary carries over with the row. Historical data
-- is left alone: shows.added_by keeps the old editor email (audit trail)
-- and free-text recommended_by attributions still say 'Whitt'.
--
-- Auto-applied on deploy by scripts/apply-migrations.sh, or by hand with:
--   wrangler d1 execute shows-db --remote --file=migrations/025_dorothy_name_email.sql

UPDATE members
SET first_name = 'Dorothy',
    name = REPLACE(name, 'Whitt', 'Dorothy')
WHERE slug = 'whitt';

-- The member_emails UPDATE that ran here swapped one specific login address
-- for another. It was applied to production once; the addresses were removed
-- from the repo so members' contact details aren't kept in source control.
