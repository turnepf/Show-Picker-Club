-- Group icons: an SF Symbol name and an accent color the creator picks, so a
-- group is recognizable at a glance everywhere its name appears (iPhone/iPad
-- Groups list and detail, Apple TV tiles). Both nullable — a group with
-- neither renders exactly as before. Values are validated by the API
-- (functions/api/groups.js): the icon must come from the curated set the
-- picker offers, the color from the named palette.
ALTER TABLE groups ADD COLUMN icon TEXT;
ALTER TABLE groups ADD COLUMN color TEXT;
