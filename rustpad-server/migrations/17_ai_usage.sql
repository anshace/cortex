-- Per-request AI token usage, for the owner/admin cost dashboard. One row per
-- assistant response: who, which org, which model, and token counts.
CREATE TABLE ai_usage(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER,                 -- null for the root owner with no org
    user_id INTEGER,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_usage_org ON ai_usage(org_id);
CREATE INDEX idx_ai_usage_user ON ai_usage(user_id);
CREATE INDEX idx_ai_usage_created ON ai_usage(created_at);
