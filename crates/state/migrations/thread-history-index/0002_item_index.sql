CREATE TABLE IF NOT EXISTS thread_history_index (
    thread_id TEXT PRIMARY KEY REFERENCES thread_streams(thread_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    header_json TEXT NOT NULL,
    header_digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_history_turns (
    thread_id TEXT NOT NULL REFERENCES thread_history_index(thread_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    turn_json TEXT NOT NULL,
    turn_digest TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    PRIMARY KEY(thread_id, turn_id),
    UNIQUE(thread_id, ordinal)
);

CREATE TABLE IF NOT EXISTS thread_history_items (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    item_json TEXT NOT NULL,
    item_digest TEXT NOT NULL,
    PRIMARY KEY(thread_id, turn_id, ordinal),
    FOREIGN KEY(thread_id, turn_id) REFERENCES thread_history_turns(thread_id, turn_id) ON DELETE CASCADE
);
