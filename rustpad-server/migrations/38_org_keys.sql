-- One data-encryption key per organization.
--
-- `dek_cipher` holds 32 random bytes, base64, sealed under this install's
-- master key. The plaintext key exists nowhere else, so destroying this row is
-- what turns "delete this organization" into a statement about the bytes on disk
-- and the bytes in every backup, not only about the rows in a table.
--
-- The key is random, NOT derived from the master key. A derived key comes back to
-- life as soon as an operator restores CORTEX_DATA_KEY or the <db>.key sidecar from
-- a backup, and every object that was supposed to be shredded reads again -- which
-- is worse than never having claimed to shred anything.
--
-- The cascade is the point of no return: it fires when the `org` row is deleted,
-- inside that transaction, so a crash cannot leave content with its key intact or
-- a key with no content.
CREATE TABLE IF NOT EXISTS org_keys (
    org_id INTEGER PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
    dek_cipher TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
