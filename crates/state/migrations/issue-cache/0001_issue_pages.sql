CREATE TABLE IF NOT EXISTS issue_pages (
    repository TEXT NOT NULL,
    state TEXT NOT NULL,
    query TEXT NOT NULL,
    page INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY(repository, state, query, page)
);

CREATE INDEX IF NOT EXISTS issue_pages_age ON issue_pages(fetched_at);
