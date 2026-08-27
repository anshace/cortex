-- Optimistic concurrency for whole-file collaborative content such as boards.
ALTER TABLE file_blob ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
