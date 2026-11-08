CREATE TABLE IF NOT EXISTS connector_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_generation INTEGER NOT NULL UNIQUE,
    connector_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    connection_generation INTEGER NOT NULL,
    account_id TEXT,
    account_display_name TEXT,
    credential_reference TEXT,
    definition_digest TEXT,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS connector_command_receipts (
    command_id TEXT PRIMARY KEY,
    expected_generation INTEGER NOT NULL,
    connector_id TEXT NOT NULL,
    command_digest TEXT NOT NULL,
    result_generation INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    snapshot_generation INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_credential_cleanup (
    connector_id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO connector_authority_meta (singleton, snapshot_generation) VALUES (1, 1);
