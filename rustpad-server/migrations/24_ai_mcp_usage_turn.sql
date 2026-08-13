-- Remote MCP connections the assistant can call (per user). The token is
-- encrypted at rest with the same AI_KEY_SECRET box as provider keys.
CREATE TABLE IF NOT EXISTS ai_mcp(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    token_cipher TEXT,                 -- nullable: some servers are unauthenticated
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ai_mcp_user ON ai_mcp(user_id);

-- Upsert-friendly turn id so cost can accrue after every round (and still
-- land if the turn errors or is truncated mid-flight). Older rows keep a
-- NULL turn_id; SQLite UNIQUE allows many NULLs.
ALTER TABLE ai_usage ADD COLUMN turn_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_turn ON ai_usage(turn_id);
