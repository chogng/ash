CREATE TABLE config_metadata (
    authority_id INTEGER PRIMARY KEY CHECK (authority_id = 1),
    document_schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    content_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_command_receipts (
    command_id TEXT PRIMARY KEY,
    expected_revision INTEGER NOT NULL,
    command_json TEXT NOT NULL,
    result_revision INTEGER NOT NULL,
    result_generation INTEGER NOT NULL
);
