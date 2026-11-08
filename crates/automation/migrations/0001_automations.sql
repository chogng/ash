CREATE TABLE IF NOT EXISTS automation_plans (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL,
    record TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_one_active_run ON automation_runs(automation_id) WHERE active = 1;

CREATE INDEX IF NOT EXISTS automation_run_history ON automation_runs(automation_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS automation_commands (
    id TEXT PRIMARY KEY,
    request TEXT NOT NULL,
    result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_deleted (
    id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS automation_events (
    subject TEXT NOT NULL,
    event_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    PRIMARY KEY(subject, event_key)
);
