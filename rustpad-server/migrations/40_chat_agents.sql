-- Agents as chat participants (Feature 01, context/feature-specs/01-chat-agents.md).
--
-- An agent is an *actor*, and every authorization, membership and audit path in
-- this server already resolves a `users` row. Adding a parallel identity table
-- would mean forking ~105 route patterns' access checks, and a single missed
-- branch there is a cross-tenant read -- so identity is reused and marked
-- (`kind`), while everything agent-specific lives in `bots`.
--
-- `kind` defaults to 'human', so every row that exists today keeps meaning what
-- it meant before this file ran. Nothing about a human's behaviour changes.
--
-- A bot's `users.password_hash` is '!' (the value replicated members already use
-- for "no credential lives here") and it gets no TOTP seed, so there is nothing
-- for a login attempt to verify against. The `kind` check at login is belt and
-- braces, not the lock.
--
-- `provider_profile` is a *name*, resolved against the existing sealed provider
-- profiles for the organization. No key lives here, and no key ever will: an
-- agent with no usable profile is unusable, and says so, rather than borrowing
-- somebody else's bill.
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';

CREATE TABLE IF NOT EXISTS bots(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- One identity row per agent, and it goes with the agent.
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    -- An agent belongs to exactly one organization. The cascade is what keeps a
    -- deleted org from leaving an agent behind; `delete_org` has to remove the
    -- `users` row too, or the org is gone and a speaking identity remains.
    org_id INTEGER NOT NULL REFERENCES org(id) ON DELETE CASCADE,
    -- The mention token: no spaces, unique per org, so `@slug` resolves without
    -- ambiguity even when two agents share a display name.
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    provider_profile TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (org_id, slug)
);

-- Mention resolution and the console's list both ask "which agents live in this
-- org, and are they listening?".
CREATE INDEX IF NOT EXISTS idx_bots_org_enabled ON bots(org_id, enabled);
