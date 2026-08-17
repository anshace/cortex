-- Org-wide groups are gone: every group is either personal (just the creator)
-- or a real group with members. Existing org-scope groups become group-scope
-- with every org member auto-added, so "everyone" is one invite away.
UPDATE groups SET scope = 'group' WHERE scope = 'org';

INSERT OR IGNORE INTO group_member (group_id, user_id, role)
SELECT g.id, u.id, 'member'
FROM groups g
JOIN users u ON u.org_id = g.org_id
WHERE g.scope = 'group'
  AND u.role != 'root';
