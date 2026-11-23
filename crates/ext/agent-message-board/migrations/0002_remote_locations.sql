CREATE TABLE IF NOT EXISTS agent_board_remote_locations (
    session TEXT NOT NULL REFERENCES agent_board_sessions(session),
    endpoint TEXT NOT NULL,
    credential_env TEXT NOT NULL,
    PRIMARY KEY(session, endpoint)
);
