CREATE TABLE IF NOT EXISTS history_records (
    digest TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
);

CREATE TABLE history_prefixes (
    digest TEXT PRIMARY KEY,
    source_thread_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL
);

CREATE TABLE history_prefix_records (
    prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest),
    sequence INTEGER NOT NULL,
    record_digest TEXT NOT NULL REFERENCES history_records(digest),
    PRIMARY KEY(prefix_digest, sequence)
);

CREATE TABLE history_prefix_links (
    prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest),
    child_digest TEXT NOT NULL REFERENCES history_prefixes(digest),
    PRIMARY KEY(prefix_digest, child_digest)
);

CREATE TABLE thread_history_prefixes (
    thread_id TEXT NOT NULL REFERENCES thread_streams(thread_id),
    prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest),
    PRIMARY KEY(thread_id, prefix_digest)
);

CREATE TABLE history_workspace_refs (
    record_digest TEXT NOT NULL REFERENCES history_records(digest),
    reference TEXT NOT NULL,
    git_directory TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    PRIMARY KEY(record_digest, reference, git_directory)
);

CREATE INDEX history_workspace_references ON history_workspace_refs(reference, git_directory);

CREATE TABLE history_checkpoint_cleanup (
    cleanup_key TEXT PRIMARY KEY,
    checkpoint_json TEXT NOT NULL
);

CREATE INDEX history_prefix_records_digest ON history_prefix_records(record_digest);
