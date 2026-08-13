-- Two-factor auth (TOTP / authenticator app). Secret is a base32 string;
-- totp_enabled flips to 1 only after the first code is verified.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
