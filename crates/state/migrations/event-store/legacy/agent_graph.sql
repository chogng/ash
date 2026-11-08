CREATE TABLE IF NOT EXISTS agent_threads (
    thread_id TEXT PRIMARY KEY REFERENCES thread_streams(thread_id),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    session_id TEXT NOT NULL,
    spawn_parent_id TEXT,
    replacement_source_id TEXT UNIQUE,
    binding_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_threads_agent ON agent_threads(agent_id, thread_id);

CREATE INDEX IF NOT EXISTS agent_threads_parent ON agent_threads(spawn_parent_id, thread_id);
