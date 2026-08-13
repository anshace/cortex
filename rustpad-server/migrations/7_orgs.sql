-- Org layer above workspaces. Owner creates orgs and assigns each user to one.
-- Any org member can create workspaces; all org members share every workspace
-- and one org-wide chat. This resets old workspace-scoped data (dev).
CREATE TABLE org(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN org_id INTEGER;

-- Clear old workspace-scoped data, then rebuild workspace (org-scoped) and
-- chat (org-wide).
DROP TABLE IF EXISTS workspace_member;
DROP TABLE IF EXISTS message;
DELETE FROM file_blob;
DELETE FROM file;
DELETE FROM document;
DROP TABLE workspace;

CREATE TABLE workspace(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES org(id),
    name TEXT NOT NULL,
    created_by INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_workspace_org ON workspace(org_id);

CREATE TABLE message(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES org(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_message_org ON message(org_id, id);
