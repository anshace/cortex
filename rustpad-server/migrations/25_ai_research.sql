-- Per-user research/search provider for the assistant's web_search tool.
-- provider: duckduckgo (free, no key) | exa | brave
CREATE TABLE IF NOT EXISTS ai_research(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'duckduckgo',
    key_cipher TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);
