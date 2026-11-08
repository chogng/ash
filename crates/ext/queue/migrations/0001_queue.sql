CREATE TABLE IF NOT EXISTS queued_messages (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    turn_id TEXT,
    error TEXT,
    revision INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    ready_at INTEGER NOT NULL DEFAULT 0,
    sort_key INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS queue_thread ON queued_messages(thread_id,position);
