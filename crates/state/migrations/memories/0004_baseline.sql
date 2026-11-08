CREATE TABLE memory_catalog (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL
);

INSERT INTO memory_catalog (singleton, revision) VALUES (1, 0);

CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    record_revision INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    normalized_search TEXT NOT NULL
);

CREATE INDEX memories_scope_id ON memories(scope_key, memory_id);

CREATE TABLE memory_tombstones (
    memory_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    deleted_revision INTEGER NOT NULL,
    catalog_revision INTEGER NOT NULL
);

CREATE TABLE memory_commands (
    command_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    record_revision INTEGER NOT NULL,
    catalog_revision INTEGER NOT NULL
);

CREATE TABLE memory_policies (
    scope_key TEXT PRIMARY KEY,
    policy_json TEXT NOT NULL
);

CREATE TABLE memory_policy_commands (
    command_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL
);
