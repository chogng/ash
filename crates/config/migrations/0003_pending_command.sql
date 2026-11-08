CREATE TABLE config_pending_command (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    command_id TEXT NOT NULL REFERENCES config_command_receipts(command_id),
    previous_digest TEXT NOT NULL,
    result_digest TEXT NOT NULL
);
