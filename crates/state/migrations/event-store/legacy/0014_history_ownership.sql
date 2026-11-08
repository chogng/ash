CREATE TABLE IF NOT EXISTS history_ownership (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    profile_id TEXT NOT NULL UNIQUE,
    receiver TEXT
);

CREATE TABLE IF NOT EXISTS history_imports (
    source TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    host TEXT NOT NULL,
    thread_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_history_bindings (
    thread_id TEXT PRIMARY KEY REFERENCES thread_streams(thread_id) ON DELETE CASCADE,
    source TEXT NOT NULL REFERENCES history_imports(source),
    host TEXT NOT NULL,
    root TEXT
);
