CREATE TABLE IF NOT EXISTS debug_workspaces (
    workspace_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    document TEXT NOT NULL,
    memento_receipt TEXT
);
