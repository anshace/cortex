-- URL slug per workspace (unique within an org), e.g. /backend.
ALTER TABLE workspace ADD COLUMN slug TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_workspace_slug ON workspace(org_id, slug);
