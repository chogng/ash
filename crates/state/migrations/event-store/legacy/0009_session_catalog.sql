CREATE TABLE IF NOT EXISTS session_catalog (
    session_id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    record_digest TEXT NOT NULL
);
