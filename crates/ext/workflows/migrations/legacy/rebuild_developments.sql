ALTER TABLE agent_parallel_developments RENAME TO agent_parallel_developments_v1;

CREATE TABLE agent_parallel_developments (
    session TEXT NOT NULL,
    root TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_order INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (session, root, run_id)
);
