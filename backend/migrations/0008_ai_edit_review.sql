-- How edits that come from an access token (an AI assistant) reach a scroll:
--   review : each one waits as a proposal until a person accepts it (the default)
--   auto   : they are applied at once (only the scroll's owner can choose this)
ALTER TABLE scrolls ADD COLUMN ai_edit_mode TEXT NOT NULL DEFAULT 'review' CHECK (ai_edit_mode IN ('review', 'auto'));

CREATE TABLE edit_proposals (
    id          UUID        PRIMARY KEY,
    scroll_id   UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_name  TEXT        NOT NULL DEFAULT '',
    kind        TEXT        NOT NULL CHECK (kind IN ('write', 'edit', 'delete')),
    path        TEXT        NOT NULL,
    old_text    TEXT,
    new_text    TEXT,
    replace_all BOOLEAN     NOT NULL DEFAULT FALSE,
    content     TEXT,
    note        TEXT        NOT NULL DEFAULT '',
    status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at  TIMESTAMPTZ,
    decided_by  UUID        REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX edit_proposals_scroll_idx ON edit_proposals (scroll_id, status, created_at);
