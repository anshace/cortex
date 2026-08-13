-- Files can now be either collaborative text ('text') or uploaded binary
-- documents ('binary', e.g. docx/pdf/images) stored as raw bytes.
ALTER TABLE file ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE file ADD COLUMN mime TEXT;

-- Raw bytes for binary files (not collaborative, no OT document).
CREATE TABLE file_blob(
    file_id INTEGER PRIMARY KEY REFERENCES file(id),
    data BLOB NOT NULL
);
