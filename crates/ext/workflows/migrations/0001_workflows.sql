CREATE TABLE IF NOT EXISTS agent_workflows (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY(session, root)
);

CREATE TABLE IF NOT EXISTS agent_workflow_commands (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    command TEXT NOT NULL,
    request TEXT NOT NULL,
    plan TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session, root, command)
);

CREATE TABLE IF NOT EXISTS agent_parallel_developments (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_order INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY(session, root, run_id)
);

CREATE TABLE IF NOT EXISTS agent_parallel_commands (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    run_id TEXT NOT NULL,
    command TEXT NOT NULL,
    request TEXT NOT NULL,
    receipt TEXT NOT NULL,
    PRIMARY KEY(session, root, run_id, command)
);

CREATE TABLE IF NOT EXISTS agent_parallel_bindings (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    delegation TEXT NOT NULL,
    intent TEXT NOT NULL,
    PRIMARY KEY(session, root, delegation)
);
