-- Give binary content somewhere else to live. Objects are keyed by the SHA-256
-- of their bytes, so two rows holding identical content share one object and a
-- file copy is a metadata insert rather than a byte move — which is what keeps
-- copy inside the existing transaction.
--
-- `data` stays NOT NULL-free by design: it holds the bytes while a deployment
-- runs the inline backend (the default), and NULL once they live in the object
-- store. `size` is recorded on both paths so byte accounting never depends on
-- where the bytes are.
ALTER TABLE file_blob ADD COLUMN storage_key TEXT;
ALTER TABLE file_blob ADD COLUMN size INTEGER;
ALTER TABLE chat_image ADD COLUMN storage_key TEXT;
ALTER TABLE chat_image ADD COLUMN size INTEGER;
