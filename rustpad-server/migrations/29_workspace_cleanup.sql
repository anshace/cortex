-- Workspaces no longer carry org/scope: those moved up to their group.
-- The columns exist only in the dev DB (migration 27 added them and they are
-- never written by the group-based code paths), so dropping them is safe.
-- SQLite's DROP COLUMN re-parses every index on the table, so all indexes must
-- go first and be recreated after.
-- (group_id stays nullable in the schema — it is always written by the app and
--  SQLite cannot ALTER a column to NOT NULL without a table rebuild.)
DROP INDEX IF EXISTS idx_workspace_org;
DROP INDEX IF EXISTS idx_workspace_scope;
DROP INDEX IF EXISTS idx_workspace_slug;
ALTER TABLE workspace DROP COLUMN org_id;
ALTER TABLE workspace DROP COLUMN scope;
CREATE INDEX IF NOT EXISTS idx_workspace_group ON workspace(group_id);
CREATE INDEX IF NOT EXISTS idx_workspace_slug ON workspace(slug);
