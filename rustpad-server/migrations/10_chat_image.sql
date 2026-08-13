-- Dedicated store for images pasted into chat, so they don't appear as
-- workspace files. Org-scoped; served only to members of the same org.
CREATE TABLE chat_image(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    mime TEXT,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_image_org ON chat_image(org_id);
