-- A line about who you write for (shown on your profile), and which browser each session was started in
-- so "active sessions" can say "Safari on macOS" instead of an anonymous row.
ALTER TABLE users ADD COLUMN affiliation TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
