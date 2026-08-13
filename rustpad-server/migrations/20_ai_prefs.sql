-- Per-scope AI preferences: which provider profile spawn_agent should use by
-- default when the prompt doesn't name one. Same scope pattern as ai_provider
-- (user overrides org), but stored separately because it has no key and no
-- profile-row lifecycle of its own.
-- Idempotent: a DB created when this migration was still numbered 19 may
-- already have this table, so re-application after the 19/20 renumber (see
-- git history) must be a no-op rather than an error.
CREATE TABLE IF NOT EXISTS ai_prefs(
    scope TEXT NOT NULL,             -- 'org' | 'user'
    scope_id INTEGER NOT NULL,
    subagent_profile TEXT NOT NULL,  -- profile name, or '' = use the main model
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id)
);
