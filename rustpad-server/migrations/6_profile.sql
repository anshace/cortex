-- Display name for users (editable in profile; defaults to empty).
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
