-- Chat images were readable by anyone in the same org, and their ids are
-- sequential, so a member could walk the range and read pictures pasted into
-- other people's DMs and personal groups. Record the conversation an upload
-- belongs to so a read can be scoped to it.
--
-- Existing attachments are backfilled from the message that embeds them; one
-- pasted into several conversations keeps its earliest, and an image that
-- references nothing at all keeps the original org-wide rule.
ALTER TABLE chat_image ADD COLUMN uploaded_by INTEGER;
ALTER TABLE chat_image ADD COLUMN group_id INTEGER;
ALTER TABLE chat_image ADD COLUMN dm_with INTEGER;

UPDATE chat_image SET
    uploaded_by = (
        SELECT m.user_id FROM message m
        WHERE m.org_id = chat_image.org_id
          AND instr(m.body, '/api/chat-image/' || chat_image.id) > 0
        ORDER BY m.id LIMIT 1
    ),
    group_id = (
        SELECT m.group_id FROM message m
        WHERE m.org_id = chat_image.org_id
          AND instr(m.body, '/api/chat-image/' || chat_image.id) > 0
        ORDER BY m.id LIMIT 1
    );

UPDATE chat_image SET
    uploaded_by = (
        SELECT d.sender_id FROM dm d
        WHERE d.org_id = chat_image.org_id
          AND instr(d.body, '/api/chat-image/' || chat_image.id) > 0
        ORDER BY d.id LIMIT 1
    ),
    dm_with = (
        SELECT d.recipient_id FROM dm d
        WHERE d.org_id = chat_image.org_id
          AND instr(d.body, '/api/chat-image/' || chat_image.id) > 0
        ORDER BY d.id LIMIT 1
    )
    WHERE uploaded_by IS NULL;
