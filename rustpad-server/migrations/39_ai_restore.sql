-- Reintroduce the AI schema retired by 26_drop_ai.sql. The AI assistant
-- (provider profiles, conversations, skills, MCP, research) was ported back
-- into the server, so the tables it reads and writes must exist again.
-- Idempotent: IF NOT EXISTS guards every object, so a database whose AI
-- tables were never dropped (or already restored) is untouched.

CREATE TABLE IF NOT EXISTS ai_provider(
    scope TEXT NOT NULL,            -- 'org' | 'user'
    scope_id INTEGER NOT NULL,
    name TEXT NOT NULL,            -- profile name (e.g. 'Default', 'Claude', 'Fast')
    provider TEXT NOT NULL,         -- 'anthropic' | 'openai' | 'azure'
    base_url TEXT,                  -- null = provider default
    model TEXT NOT NULL,
    key_cipher TEXT NOT NULL,       -- base64(nonce || AES-GCM ciphertext)
    is_current INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id, name)
);

CREATE TABLE IF NOT EXISTS ai_usage(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER,                 -- null for the root owner with no org
    user_id INTEGER,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    turn_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org ON ai_usage(org_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_turn ON ai_usage(turn_id);

CREATE TABLE IF NOT EXISTS ai_conv(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    wire TEXT NOT NULL,
    visible TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    shared_with TEXT NOT NULL DEFAULT '[]',
    title TEXT,
    pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_conv_scope ON ai_conv(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS ai_prefs(
    scope TEXT NOT NULL,             -- 'org' | 'user'
    scope_id INTEGER NOT NULL,
    subagent_profile TEXT NOT NULL,  -- profile name, or '' = use the main model
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id)
);

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

CREATE TABLE IF NOT EXISTS ai_research(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'duckduckgo',
    key_cipher TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);