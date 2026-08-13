-- Message editing: track when a message was last edited (NULL = never).
ALTER TABLE message ADD COLUMN edited_at INTEGER;
ALTER TABLE dm ADD COLUMN edited_at INTEGER;
