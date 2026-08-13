-- Per-user reusable AI skills, backed by the server so they follow the user
-- across machines and can steer the model's system prompt automatically.
-- Replaces the old client-side localStorage list (the client migrates any
-- leftover local skills on first fetch).
CREATE TABLE IF NOT EXISTS ai_skills(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'custom',  -- 'custom' | 'github' | 'bundled'
    source_url TEXT,                        -- repo/raw URL for github imports
    always_on INTEGER NOT NULL DEFAULT 0,   -- inject into EVERY system prompt
    auto_load TEXT NOT NULL DEFAULT '',     -- comma-separated trigger keywords
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ai_skills_user ON ai_skills(user_id);
