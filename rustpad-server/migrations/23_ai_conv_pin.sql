-- Owner pins a conversation so it stays at the top of their history sidebar.
-- 0 = not pinned, 1 = pinned. Pins follow the owner across machines.
ALTER TABLE ai_conv ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
