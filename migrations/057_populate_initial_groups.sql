-- Populate initial groups with members
-- Add members to Kiawah Krew
INSERT INTO group_members (group_id, member_slug)
SELECT id, 'jane' FROM groups WHERE name = 'Kiawah Krew'
WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'Kiawah Krew') AND member_slug = 'jane');

INSERT INTO group_members (group_id, member_slug)
SELECT id, 'joe' FROM groups WHERE name = 'Kiawah Krew'
WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'Kiawah Krew') AND member_slug = 'joe');

INSERT INTO group_members (group_id, member_slug)
SELECT id, 'paula' FROM groups WHERE name = 'Kiawah Krew'
WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'Kiawah Krew') AND member_slug = 'paula');

INSERT INTO group_members (group_id, member_slug)
SELECT id, 'brad' FROM groups WHERE name = 'Kiawah Krew'
WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'Kiawah Krew') AND member_slug = 'brad');

-- Add members to PAWF
INSERT INTO group_members (group_id, member_slug)
SELECT id, 'william' FROM groups WHERE name = 'PAWF'
WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'PAWF') AND member_slug = 'william');

INSERT INTO group_members (group_id, member_slug)
SELECT id, 'fiona' FROM groups WHERE name = 'PAWF'
WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = (SELECT id FROM groups WHERE name = 'PAWF') AND member_slug = 'fiona');
