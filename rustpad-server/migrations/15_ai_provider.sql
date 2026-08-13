-- Per-scope AI provider config. One row per (scope, scope_id):
--   scope 'org'  -> scope_id = org id  (the org default, set by owner/admin)
--   scope 'user' -> scope_id = user id (that user's personal override)
-- The API key is stored AES-GCM encrypted (see crypto::secret_encrypt); never
-- returned to the client.
CREATE TABLE ai_provider(
    scope TEXT NOT NULL,            -- 'org' | 'user'
    scope_id INTEGER NOT NULL,
    provider TEXT NOT NULL,         -- 'anthropic' | 'openai'
    base_url TEXT,                  -- null = provider default
    model TEXT NOT NULL,
    key_cipher TEXT NOT NULL,       -- base64(nonce || AES-GCM ciphertext)
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id)
);
