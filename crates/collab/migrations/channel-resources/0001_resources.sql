CREATE TABLE IF NOT EXISTS collaboration_spaces (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaboration_channel_members (
    credential TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES collaboration_spaces(id),
    member_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS collaboration_channel_members_space ON collaboration_channel_members(space_id);

CREATE TABLE IF NOT EXISTS collaboration_channel_resources (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES collaboration_spaces(id),
    channel_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaboration_resource_grants (
    credential TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES collaboration_channel_resources(id),
    member_id TEXT NOT NULL
);
