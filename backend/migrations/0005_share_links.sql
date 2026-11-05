-- Share links: one for editing (scribe) and one for viewing (reader) per scroll. Anyone who is
-- signed in and opens the link takes a seat at that level. The owner can reset or turn them off.
CREATE TABLE share_links (
    scroll_id  UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('scribe', 'reader')),
    token      TEXT        NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scroll_id, role)
);
