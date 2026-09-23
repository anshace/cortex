-- Migration 28 accidentally used workspace.id rather than workspace.group_id
-- when copying both membership and chat. IDs can differ after historic deletes.
UPDATE message
SET group_id = (SELECT w.group_id FROM workspace w WHERE w.id = message.workspace_id)
WHERE workspace_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM workspace w WHERE w.id = message.workspace_id AND w.group_id IS NOT NULL);

-- Remove the misdirected old membership rows before rebuilding them. Keep any
-- membership which also belonged to the destination group in the old schema.
DELETE FROM group_member
WHERE role != 'owner'
  AND EXISTS (
      SELECT 1 FROM workspace_member wm JOIN workspace w ON w.id = wm.workspace_id
      WHERE wm.workspace_id = group_member.group_id
        AND wm.user_id = group_member.user_id
        AND w.group_id != group_member.group_id
  )
  AND NOT EXISTS (
      SELECT 1 FROM workspace_member wm JOIN workspace w ON w.id = wm.workspace_id
      WHERE w.group_id = group_member.group_id AND wm.user_id = group_member.user_id
  );

INSERT OR IGNORE INTO group_member (group_id, user_id, role)
SELECT w.group_id, wm.user_id, wm.role
FROM workspace_member wm
JOIN workspace w ON w.id = wm.workspace_id
JOIN groups g ON g.id = w.group_id
JOIN users u ON u.id = wm.user_id
WHERE u.org_id = g.org_id;

-- This obsolete table still has a foreign key to workspace. Leaving it in
-- place makes workspace/group/org deletion fail for pre-migration projects.
DROP TABLE workspace_member;

-- The most frequently pruned rows should not require full table scans.
CREATE INDEX idx_session_expires ON session(expires_at);
CREATE INDEX idx_chat_image_created ON chat_image(created_at);

-- Every text file needs a seeded document. Older versions only created a file
-- row and waited for the first OT edit, leaving empty files without a row.
INSERT OR IGNORE INTO document (id, text, language)
SELECT doc_id, '', NULL FROM file WHERE kind = 'text';
