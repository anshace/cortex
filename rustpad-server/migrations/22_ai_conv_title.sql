-- Optional custom title for a conversation. NULL = derive from the first user
-- message (existing behavior); a non-NULL value is what the owner renamed it to.
ALTER TABLE ai_conv ADD COLUMN title TEXT;
