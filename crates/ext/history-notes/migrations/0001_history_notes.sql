CREATE TABLE IF NOT EXISTS task_notes (
    session TEXT NOT NULL,
    thread TEXT NOT NULL,
    path TEXT NOT NULL,
    revision INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY(session, thread, path)
);
