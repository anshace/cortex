-- The routing index multi-tenancy starts from: one row per document saying
-- which org owns it, so the control plane can answer "which database do I
-- open for doc 1234?" without any joins — and later, without even a local
-- `file` table. `doc_id` is TEXT because that is what `file.doc_id` is: a
-- random hex id, numeric only in the loose sense that it is opaque.
--
-- The app maintains this table in the same transaction as the `file` rows it
-- mirrors (create, move, delete), so it never drifts; rows that predate the
-- table are picked up by a backfill at every boot, making an upgrade from an
-- old database a no-downtime, no-op-the-second-time-around repair.
CREATE TABLE IF NOT EXISTS doc_org(
    doc_id TEXT PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES org(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);

-- An org's documents move (and are cleaned up) as a set, so lookups by org
-- must not scan the whole index.
CREATE INDEX IF NOT EXISTS idx_doc_org_org ON doc_org(org_id);
