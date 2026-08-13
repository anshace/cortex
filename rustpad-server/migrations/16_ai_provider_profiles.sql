-- Support up to 3 named provider profiles per scope, one marked current.
-- Each profile has its own provider/base_url/model/key. SQLite can't alter a
-- primary key, so rebuild the table and carry existing rows over as a current
-- "Default" profile.
ALTER TABLE ai_provider RENAME TO ai_provider_old;

CREATE TABLE ai_provider(
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

INSERT INTO ai_provider (scope, scope_id, name, provider, base_url, model, key_cipher, is_current, updated_at)
    SELECT scope, scope_id, 'Default', provider, base_url, model, key_cipher, 1, updated_at
    FROM ai_provider_old;

DROP TABLE ai_provider_old;
