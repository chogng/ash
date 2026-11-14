CREATE TABLE pending_thread_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    turn_json TEXT NOT NULL,
    turn_digest TEXT NOT NULL,
    UNIQUE (thread_id, sequence)
);
