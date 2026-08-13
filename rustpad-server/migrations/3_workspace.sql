-- Workspaces: one per owner (admins own; regular users are added as members).
CREATE TABLE workspace(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    created_at INTEGER NOT NULL
);

-- Membership. The owner is inserted as a member on creation.
CREATE TABLE workspace_member(
    workspace_id INTEGER NOT NULL REFERENCES workspace(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (workspace_id, user_id)
);

-- Files. Each file's content is a collaborative OT document keyed by doc_id,
-- stored in the existing `document` table. path is unique within a workspace.
CREATE TABLE file(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id),
    path TEXT NOT NULL,
    doc_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace_id, path)
);
