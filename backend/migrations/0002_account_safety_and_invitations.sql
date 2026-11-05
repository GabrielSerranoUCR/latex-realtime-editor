-- Email verification, password reset, and invitations that work for people without accounts.

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

-- One-time tokens mailed to users. Only the SHA-256 hash is stored.
CREATE TABLE email_tokens (
    token_hash BYTEA PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       TEXT        NOT NULL CHECK (kind IN ('verify', 'reset')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, kind);

-- An invitation is addressed to an email. It can be accepted only by a signed-in user whose
-- *verified* email matches, so signing up with someone else's address reveals nothing.
CREATE TABLE invitations (
    id         UUID PRIMARY KEY,
    scroll_id  UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    email      TEXT        NOT NULL,
    role       TEXT        NOT NULL CHECK (role IN ('scribe', 'reader')),
    invited_by UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX invitations_scroll_email_idx ON invitations (scroll_id, lower(email));
CREATE INDEX invitations_email_idx ON invitations (lower(email));
