-- Two-tier chat:
--   * workspace group chat  -> `message` scoped by workspace_id
--   * org-wide 1:1 direct    -> new `dm` table
-- The old org-wide `message` rows are cleared (dev reset; no real history yet).

ALTER TABLE message ADD COLUMN workspace_id INTEGER;
DELETE FROM message;
CREATE INDEX idx_message_ws ON message(workspace_id, id);

CREATE TABLE dm(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_dm_pair ON dm(org_id, sender_id, recipient_id, id);
