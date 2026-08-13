-- Share an assistant conversation with specific team members. `shared_with` is
-- a JSON array of user ids (co-members of the same org) who may view and
-- continue the conversation; '[]' = private to the owner. The owner's row
-- remains the canonical wire history; shared members read and update it too.
ALTER TABLE ai_conv ADD COLUMN shared_with TEXT NOT NULL DEFAULT '[]';
