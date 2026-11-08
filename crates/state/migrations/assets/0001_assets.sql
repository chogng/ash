CREATE TABLE asset_contents (
    sha256 TEXT PRIMARY KEY,
    bytes BLOB NOT NULL
);

CREATE TABLE assets (
    asset_id TEXT PRIMARY KEY
);

CREATE TABLE asset_versions (
    version_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(asset_id),
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    sha256 TEXT NOT NULL REFERENCES asset_contents(sha256),
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL
);

CREATE INDEX asset_versions_asset ON asset_versions(asset_id);
