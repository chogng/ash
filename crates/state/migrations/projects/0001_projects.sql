CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL
);

CREATE TABLE project_commands (
    command_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    request_json TEXT NOT NULL,
    result_revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE INDEX project_commands_project_revision ON project_commands(project_id, result_revision);
