CREATE TABLE teams (
    team_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL
);

CREATE TABLE team_commands (
    command_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL
);

CREATE TABLE team_runs (
    run_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    session_id TEXT NOT NULL,
    record_json TEXT NOT NULL
);

CREATE INDEX team_runs_team ON team_runs(team_id, run_id);

CREATE TABLE team_run_commands (
    command_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL
);

CREATE TABLE team_run_threads (
    thread_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES team_runs(run_id),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id)
);

CREATE INDEX team_run_threads_run ON team_run_threads(run_id, thread_id);

CREATE TABLE team_messages (
    message_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(team_id),
    record_json TEXT NOT NULL
);

CREATE INDEX team_messages_team ON team_messages(team_id, message_id);
