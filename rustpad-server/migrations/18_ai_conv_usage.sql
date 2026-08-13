-- Richer per-request AI usage: cache-read tokens, cache-write tokens, thinking
-- tokens, and the dollar cost (provider-reported, else a list-price estimate).
ALTER TABLE ai_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN cost REAL NOT NULL DEFAULT 0;

-- Canonical wire-format conversation history, keyed by the client's conversation
-- id and scoped to (user, workspace). The server resends EXACTLY the same prefix
-- it sent last turn (assistant tool_use blocks, thinking signatures, tool
-- results included), which is what makes provider prompt-cache hits possible —
-- the client only keeps the visible text, which is not byte-identical to the
-- wire format. `visible` is the client-shaped {role, content} list used to
-- reconcile against what the browser sends on the next turn.
CREATE TABLE ai_conv(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    wire TEXT NOT NULL,
    visible TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_conv_scope ON ai_conv(user_id, workspace_id);
