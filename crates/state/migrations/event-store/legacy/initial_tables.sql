CREATE TABLE history_records (
    digest TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
);

CREATE TABLE thread_streams (
    thread_id TEXT PRIMARY KEY,
    current_sequence INTEGER NOT NULL
);

CREATE TABLE thread_batches (
    thread_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    expected_sequence INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    PRIMARY KEY (thread_id, batch_id),
    FOREIGN KEY (thread_id) REFERENCES thread_streams(thread_id)
);

CREATE TABLE thread_events (
    thread_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    record_digest TEXT NOT NULL REFERENCES history_records(digest),
    PRIMARY KEY (thread_id, sequence),
    FOREIGN KEY (thread_id) REFERENCES thread_streams(thread_id)
);

CREATE TABLE turn_change_sets (
    change_set_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL
);

CREATE TABLE turn_change_commands (
    command_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL
);
