-- Add a full last_name column so we stop parsing it out of members.name
-- (which is the possessive "Carter's Shows" display string) or making do
-- with just last_initial. last_initial stays around to avoid breaking
-- callers; new code should prefer last_name.

-- ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite. Run this once.
-- (Already applied to prod 2026-06-03 — see UPDATEs below.)
-- ALTER TABLE members ADD COLUMN last_name TEXT;

-- Backfill known members. Anyone added through /setup from here on out
-- will get last_name written directly by admin-create-member.
UPDATE members SET last_name = 'Bennett'  WHERE slug = 'brad';
UPDATE members SET last_name = 'Bennett'  WHERE slug = 'paula';
UPDATE members SET last_name = 'Brownlee' WHERE slug = 'amy';
UPDATE members SET last_name = 'Brownlee' WHERE slug = 'chuck';
UPDATE members SET last_name = 'Brownlee' WHERE slug = 'kirsten';
UPDATE members SET last_name = 'Brownlee' WHERE slug = 'leon';
UPDATE members SET last_name = 'Barrett'  WHERE slug = 'mb';
UPDATE members SET last_name = 'Barnett'  WHERE slug = 'jessica';
UPDATE members SET last_name = 'Biggs'    WHERE slug = 'jennifer';
UPDATE members SET last_name = 'Brooks'   WHERE slug = 'joey';
UPDATE members SET last_name = 'Maltzahn' WHERE slug = 'rob';
UPDATE members SET last_name = 'McDowell' WHERE slug = 'carter';
UPDATE members SET last_name = 'Morris'   WHERE slug = 'sherry';
UPDATE members SET last_name = 'Morris'   WHERE slug = 'susan';
UPDATE members SET last_name = 'Potter'   WHERE slug = 'joe';
UPDATE members SET last_name = 'Potter'   WHERE slug = 'laurin';
UPDATE members SET last_name = 'Shamblin' WHERE slug = 'tori';
UPDATE members SET last_name = 'Shuford'  WHERE slug = 'whitt';
UPDATE members SET last_name = 'Turner'   WHERE slug = 'fiona';
UPDATE members SET last_name = 'Turner'   WHERE slug = 'patrick';
UPDATE members SET last_name = 'Turner'   WHERE slug = 'william';
UPDATE members SET last_name = 'Wolf'     WHERE slug = 'annie';
UPDATE members SET last_name = 'Wolf'     WHERE slug = 'kelly';
UPDATE members SET last_name = 'Brownlee' WHERE slug = 'justin';
UPDATE members SET last_name = 'Kirk'     WHERE slug = 'kathleen';
UPDATE members SET last_name = 'Bender'   WHERE slug = 'kevin';
UPDATE members SET last_name = 'Clark'    WHERE slug = 'lisa';
-- Terry has only last_initial='B' on file; leave last_name NULL until
-- we get the full name.
