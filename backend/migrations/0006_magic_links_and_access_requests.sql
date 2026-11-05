-- Magic links: a one-time sign-in link emailed to the account's address.
ALTER TABLE email_tokens DROP CONSTRAINT email_tokens_kind_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_kind_check CHECK (kind IN ('verify', 'reset', 'magic'));

-- "You need a seat": a signed-in person without access asks the owner to let them in.
CREATE TABLE access_requests (
    scroll_id  UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message    TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scroll_id, user_id)
);
