CREATE TABLE thread_event_refs (
    thread_id TEXT NOT NULL REFERENCES thread_streams(thread_id),
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    record_digest TEXT NOT NULL REFERENCES history_records(digest),
    PRIMARY KEY(thread_id, sequence)
);
