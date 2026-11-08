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

DROP TABLE IF EXISTS session_events;

DROP TABLE IF EXISTS session_batches;

DROP TABLE IF EXISTS session_streams;
