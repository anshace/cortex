-- Workspace chat: any member can post; messages are markdown text.
CREATE TABLE message(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspace(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_message_workspace ON message(workspace_id, id);
