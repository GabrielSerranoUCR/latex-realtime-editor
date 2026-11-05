-- Accounts, sessions, scrolls (documents) and who may do what with them.

CREATE TABLE users (
    id            UUID PRIMARY KEY,
    email         TEXT        NOT NULL,
    display_name  TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    color         TEXT        NOT NULL,           -- cursor colour shown to other scribes
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Opaque session tokens; only a SHA-256 hash is stored, so a database leak cannot be replayed.
CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE scrolls (
    id         UUID PRIMARY KEY,                  -- also the collaboration room id
    title      TEXT        NOT NULL,
    owner_id   UUID        NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ                        -- soft delete ("the cellar")
);

CREATE TABLE scroll_members (
    scroll_id  UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('owner', 'scribe', 'reader')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scroll_id, user_id)
);
CREATE INDEX scroll_members_user_idx ON scroll_members (user_id);
-- exactly one owner per scroll
CREATE UNIQUE INDEX scroll_one_owner_idx ON scroll_members (scroll_id) WHERE role = 'owner';
