CREATE TABLE backup_workspaces (
    client_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    descriptor TEXT NOT NULL,
    PRIMARY KEY (client_id, workspace_id)
);

CREATE TABLE backup_contents (
    client_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    format TEXT NOT NULL,
    content TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, workspace_id, resource),
    FOREIGN KEY (client_id, workspace_id) REFERENCES backup_workspaces(client_id, workspace_id) ON DELETE CASCADE
);
