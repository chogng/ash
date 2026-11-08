CREATE TABLE IF NOT EXISTS symphony_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    version INTEGER NOT NULL,
    body TEXT NOT NULL
);
