CREATE TABLE queue_invalidations (
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (session_id, thread_id)
);
CREATE INDEX queue_invalidations_revision ON queue_invalidations(revision);
