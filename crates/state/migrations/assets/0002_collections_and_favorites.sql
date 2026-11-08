ALTER TABLE assets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;

ALTER TABLE asset_versions ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE asset_collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE asset_collection_entries (
    asset_id TEXT NOT NULL REFERENCES assets(asset_id),
    collection_id TEXT NOT NULL REFERENCES asset_collections(id) ON DELETE CASCADE,
    PRIMARY KEY (asset_id, collection_id)
);
