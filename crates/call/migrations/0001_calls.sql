CREATE TABLE IF NOT EXISTS media_calls (
    id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_members (
    credential TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    member_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_devices (
    call_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY(call_id, member_id)
);

CREATE TABLE IF NOT EXISTS media_operations (
    actor TEXT NOT NULL,
    operation TEXT NOT NULL,
    request TEXT NOT NULL,
    call_id TEXT NOT NULL,
    PRIMARY KEY(actor, operation)
);
