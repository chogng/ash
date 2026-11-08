CREATE TABLE approval_environments (
    project TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    profile TEXT NOT NULL
);

CREATE TABLE approval_environment_commands (
    project TEXT NOT NULL,
    command_id TEXT NOT NULL,
    request TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY(project, command_id)
);
