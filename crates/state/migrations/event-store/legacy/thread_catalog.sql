CREATE TABLE IF NOT EXISTS thread_catalog (
    thread_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    requires_startup_recovery INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    record_digest TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES thread_streams(thread_id)
);

CREATE INDEX IF NOT EXISTS thread_catalog_session ON thread_catalog(session_id, thread_id);

CREATE INDEX IF NOT EXISTS thread_catalog_startup_recovery ON thread_catalog(requires_startup_recovery, session_id, thread_id);

CREATE INDEX IF NOT EXISTS turn_change_sets_thread_revision ON turn_change_sets(thread_id, revision);
