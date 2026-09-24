-- Instance-level switches the owner can flip from the console. The only one
-- today is the audit log: it is the table that grows without any user deleting
-- from it (every login writes a row), and on a small single-file deployment
-- that is real space, so it has to be possible to stop it.
CREATE TABLE IF NOT EXISTS app_setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
