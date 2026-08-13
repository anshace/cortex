-- Audit log: security-relevant actions (login, file create/download/delete,
-- admin user changes). org_id/user_id may be NULL for root/system actions.
CREATE TABLE audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER,
    user_id    INTEGER,
    action     TEXT    NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_org ON audit (org_id, id);
