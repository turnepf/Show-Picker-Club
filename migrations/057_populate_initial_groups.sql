-- Populate initial groups with members
-- Add members to Kiawah Krew
INSERT OR IGNORE INTO group_members (group_id, member_slug)
SELECT id, 'jane' FROM groups WHERE name = 'Kiawah Krew';

INSERT OR IGNORE INTO group_members (group_id, member_slug)
SELECT id, 'joe' FROM groups WHERE name = 'Kiawah Krew';

INSERT OR IGNORE INTO group_members (group_id, member_slug)
SELECT id, 'paula' FROM groups WHERE name = 'Kiawah Krew';

INSERT OR IGNORE INTO group_members (group_id, member_slug)
SELECT id, 'brad' FROM groups WHERE name = 'Kiawah Krew';

-- Add members to PAWF
INSERT OR IGNORE INTO group_members (group_id, member_slug)
SELECT id, 'william' FROM groups WHERE name = 'PAWF';

INSERT OR IGNORE INTO group_members (group_id, member_slug)
SELECT id, 'fiona' FROM groups WHERE name = 'PAWF';
