-- Groups become the top-level container: a group is the conversation and
-- people hub (scope: personal | group | org), and it holds one or more
-- workspaces (file/code projects) inside it. The sidebar's main section is the
-- group; workspaces live underneath.

CREATE TABLE IF NOT EXISTS groups(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES org(id),
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'group',
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_org ON groups(org_id);

CREATE TABLE IF NOT EXISTS group_member(
    group_id INTEGER NOT NULL REFERENCES groups(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (group_id, user_id)
);

-- Backfill: every existing workspace becomes its own group (ids align 1:1
-- because both sequences are empty and we insert in workspace id order), and
-- workspace membership carries over to the group.
-- Workspaces whose org has since been deleted are unreachable dead rows: skip
-- them in the backfill (and in the group_id backfill below) so the FK on
-- org(id)/groups(id) can't fail and take the app down at startup.
INSERT OR IGNORE INTO groups (org_id, name, scope, created_by, created_at)
    SELECT org_id, name, scope, created_by, created_at
    FROM workspace
    WHERE org_id IN (SELECT id FROM org)
    ORDER BY id;
INSERT OR IGNORE INTO group_member (group_id, user_id, role)
    SELECT workspace_id, user_id, role FROM workspace_member;

-- Workspaces now belong to a group; each existing workspace is attached to its
-- own backfilled group (orphaned workspaces stay ungrouped and invisible).
ALTER TABLE workspace ADD COLUMN group_id INTEGER REFERENCES groups(id);
UPDATE workspace SET group_id = id WHERE org_id IN (SELECT id FROM org);

-- Group chat lives on the group, not the workspace.
ALTER TABLE message ADD COLUMN group_id INTEGER;
UPDATE message SET group_id = workspace_id WHERE workspace_id IS NOT NULL;
DROP INDEX IF EXISTS idx_message_ws;
CREATE INDEX IF NOT EXISTS idx_message_group ON message(group_id, id);
