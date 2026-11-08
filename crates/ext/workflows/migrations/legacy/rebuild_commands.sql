ALTER TABLE agent_parallel_commands RENAME TO agent_parallel_commands_v1;

CREATE TABLE agent_parallel_commands (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    run_id TEXT NOT NULL,
    command TEXT NOT NULL,
    request TEXT NOT NULL,
    receipt TEXT NOT NULL,
    PRIMARY KEY (session, root, run_id, command)
);
