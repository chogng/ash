CREATE TABLE message_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('agent', 'shell', 'command')),
    thread_id TEXT,
    text TEXT NOT NULL,
    search_text TEXT NOT NULL,
    text_bytes INTEGER NOT NULL CHECK(text_bytes > 0)
);

CREATE INDEX message_history_kind ON message_history(kind, id);
