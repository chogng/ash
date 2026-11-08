CREATE TABLE IF NOT EXISTS document_collaboration_rooms (
    room_id TEXT PRIMARY KEY NOT NULL,
    schema_id TEXT NOT NULL,
    document TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 0),
    presence_generation INTEGER NOT NULL DEFAULT 0 CHECK(presence_generation >= 0)
);
CREATE TABLE IF NOT EXISTS document_collaboration_updates (
    room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    client_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    base_version INTEGER NOT NULL CHECK(base_version >= 0),
    transaction_json TEXT NOT NULL,
    document TEXT NOT NULL,
    PRIMARY KEY (room_id, version),
    UNIQUE (room_id, client_id, sequence)
);
CREATE INDEX IF NOT EXISTS document_collaboration_updates_replay
    ON document_collaboration_updates (room_id, version);
CREATE TABLE IF NOT EXISTS document_collaboration_room_members (
    room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
    token_hash TEXT,
    created_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    PRIMARY KEY (room_id, principal_id),
    UNIQUE (room_id, token_hash)
);
CREATE INDEX IF NOT EXISTS document_collaboration_room_member_tokens
    ON document_collaboration_room_members (room_id, token_hash);
CREATE TABLE IF NOT EXISTS document_collaboration_audit_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
    actor_principal_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    subject_principal_id TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS document_collaboration_audit_room
    ON document_collaboration_audit_events (room_id, event_id);
CREATE TABLE IF NOT EXISTS document_collaboration_presence (
    room_id TEXT NOT NULL REFERENCES document_collaboration_rooms(room_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    selection_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (room_id, client_id)
);
CREATE INDEX IF NOT EXISTS document_collaboration_presence_active
    ON document_collaboration_presence (room_id, updated_at_ms);
