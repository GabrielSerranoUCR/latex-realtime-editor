-- Yjs document state, binary assets (images, PDFs) and version history.

-- The live document, as one Yjs update (replaces the filesystem snapshots).
CREATE TABLE scroll_docs (
    scroll_id  UUID PRIMARY KEY REFERENCES scrolls (id) ON DELETE CASCADE,
    snapshot   BYTEA       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Binary project files. Metadata here (and mirrored in the Yjs `assets` map so every client
-- sees changes live); the bytes live on disk under data/assets/<scroll>/<path>.
CREATE TABLE scroll_assets (
    scroll_id  UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    path       TEXT        NOT NULL,
    size       BIGINT      NOT NULL,
    mime       TEXT        NOT NULL,
    sha256     TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scroll_id, path)
);

-- Point-in-time copies of a scroll: automatic ("auto") ones are pruned, named ones are kept.
CREATE TABLE scroll_versions (
    id         UUID PRIMARY KEY,
    scroll_id  UUID        NOT NULL REFERENCES scrolls (id) ON DELETE CASCADE,
    created_by UUID        REFERENCES users (id) ON DELETE SET NULL,
    label      TEXT,
    auto       BOOLEAN     NOT NULL,
    sha256     BYTEA       NOT NULL,
    snapshot   BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scroll_versions_scroll_idx ON scroll_versions (scroll_id, created_at DESC);
