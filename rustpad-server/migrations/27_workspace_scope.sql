-- Workspace scoping: three layers inside an org.
--   'org'      — visible to every member of the org (default, backward compatible)
--   'group'    — visible only to members listed in workspace_member
--   'personal' — visible only to its creator
ALTER TABLE workspace ADD COLUMN scope TEXT NOT NULL DEFAULT 'org';

-- Membership for group-scoped workspaces. The creator is inserted on creation.
CREATE TABLE workspace_member(
    workspace_id INTEGER NOT NULL REFERENCES workspace(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (workspace_id, user_id)
);

-- Existing workspaces keep the org-wide behaviour.
UPDATE workspace SET scope = 'org';
