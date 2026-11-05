-- Personal access tokens: let a program (an AI assistant through MCP, a script) act as its owner, over HTTP.
-- Only the SHA-256 hash is kept; the token itself is shown once, when it is made.
CREATE TABLE api_tokens (
    id           UUID        PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    token_hash   BYTEA       NOT NULL UNIQUE,
    -- false: may read and compile only; true: may also change scrolls
    write        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);
