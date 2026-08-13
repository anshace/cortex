-- Remove the AI schema retired after migration 25.
DELETE FROM audit WHERE action LIKE 'ai_%';

DROP INDEX IF EXISTS idx_ai_usage_org;
DROP INDEX IF EXISTS idx_ai_usage_user;
DROP INDEX IF EXISTS idx_ai_usage_created;
DROP INDEX IF EXISTS idx_ai_usage_turn;
DROP INDEX IF EXISTS idx_ai_conv_scope;
DROP INDEX IF EXISTS idx_ai_skills_user;
DROP INDEX IF EXISTS idx_ai_mcp_user;

DROP TABLE IF EXISTS ai_provider;
DROP TABLE IF EXISTS ai_provider_old;
DROP TABLE IF EXISTS ai_usage;
DROP TABLE IF EXISTS ai_conv;
DROP TABLE IF EXISTS ai_prefs;
DROP TABLE IF EXISTS ai_skills;
DROP TABLE IF EXISTS ai_mcp;
DROP TABLE IF EXISTS ai_research;
