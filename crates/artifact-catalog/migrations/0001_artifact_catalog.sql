CREATE TABLE artifact_catalog (
    client_id TEXT NOT NULL,
    id TEXT NOT NULL,
    resource TEXT NOT NULL,
    title TEXT NOT NULL,
    content_type TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    account_id TEXT,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, id)
);

-- SQLite normally treats NULLs as distinct in unique indexes. Empty account IDs
-- are invalid at the store boundary, so this also deduplicates anonymous sources.
CREATE UNIQUE INDEX artifact_catalog_source ON artifact_catalog (
    client_id, provider_id, COALESCE(account_id, ''), session_id, thread_id, item_id, part_id
);
