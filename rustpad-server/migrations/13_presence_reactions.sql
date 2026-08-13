-- Presence: last time each user was seen (0 = never). Updated by a heartbeat.
ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;

-- Emoji reactions on chat/DM messages. `kind` selects which table `msg_id`
-- points at ('ws' = message, 'dm' = dm). One row per (message, user, emoji).
CREATE TABLE reaction (
    kind    TEXT    NOT NULL,
    msg_id  INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji   TEXT    NOT NULL,
    PRIMARY KEY (kind, msg_id, user_id, emoji)
);
