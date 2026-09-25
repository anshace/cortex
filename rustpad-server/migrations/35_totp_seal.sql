-- TOTP seeds were stored as plaintext base32, so any read of the database file —
-- a backup, a volume snapshot, an operator shell — handed out a working second
-- factor for every account. The seed now lives in an AES-256-GCM envelope keyed
-- outside this file (src/keystore.rs). The plaintext column is emptied by a
-- backfill at startup and stays declared only because migrations are forward-only.
ALTER TABLE users ADD COLUMN totp_secret_cipher TEXT;
