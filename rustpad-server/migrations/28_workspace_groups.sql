-- Groups become the top-level container: a group is the conversation and
-- people hub (scope: personal | group | org), and it holds one or more
-- workspaces (file/code projects) inside it. The sidebar's main section is the
-- group; workspaces live underneath.

CREATE TABLE groups(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES org(id),
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'group',
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_groups_org ON groups(org_id);

CREATE TABLE group_member(
    group_id INTEGER NOT NULL REFERENCES groups(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (group_id, user_id)
);

-- Backfill: every existing workspace becomes its own group (ids align 1:1
-- because both sequences are empty and we insert in workspace id order), and
-- workspace membership carries over to the group.
INSERT INTO groups (org_id, name, scope, created_by, created_at)
    SELECT org_id, name, scope, created_by, created_at FROM workspace ORDER BY id;
INSERT INTO group_member (group_id, user_id, role)
    SELECT workspace_id, user_id, role FROM workspace_member;

-- Workspaces now belong to a group; each existing workspace is attached to its
-- own backfilled group.
ALTER TABLE workspace ADD COLUMN group_id INTEGER REFERENCES groups(id);
UPDATE workspace SET group_id = id;

-- Group chat lives on the group, not the workspace.
ALTER TABLE message ADD COLUMN group_id INTEGER;
UPDATE message SET group_id = workspace_id WHERE workspace_id IS NOT NULL;
DROP INDEX IF EXISTS idx_message_ws;
CREATE INDEX idx_message_group ON message(group_id, id);
