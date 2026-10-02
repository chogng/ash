use crate::SqliteDurability;
use crate::open_sqlite_database;
use assets::AssetError;
use assets::AssetStore;
use assets::AssetVersion;
use assets::Catalog;
use assets::CatalogEntry;
use assets::Collection;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::path::Path;
use std::sync::Mutex;

/// Profile-local asset catalog and content. One transaction publishes both the immutable version
/// and its original bytes, so recovery never exposes a version whose content was not committed.
pub struct SqliteAssetStore {
    connection: Mutex<Connection>,
}

impl SqliteAssetStore {
    pub fn open(path: &Path) -> Result<Self, AssetError> {
        let mut connection =
            open_sqlite_database(path, SqliteDurability::Durable).map_err(AssetError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS ash_schema_migrations (component TEXT PRIMARY KEY, version INTEGER NOT NULL);").map_err(storage_error)?;
        let version: Option<u32> = transaction
            .query_row(
                "SELECT version FROM ash_schema_migrations WHERE component = 'assets'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        match version {
            None => {
                transaction.execute_batch("CREATE TABLE asset_contents (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL);
                    CREATE TABLE assets (asset_id TEXT PRIMARY KEY);
                    CREATE TABLE asset_versions (
                        version_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id),
                        name TEXT NOT NULL, source TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES asset_contents(sha256),
                        media_type TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL);
                    CREATE INDEX asset_versions_asset ON asset_versions(asset_id);
                    INSERT INTO ash_schema_migrations VALUES ('assets', 1);").map_err(storage_error)?;
            }
            Some(1 | 2) => {}
            Some(version) => {
                return Err(AssetError::Storage(format!(
                    "unsupported asset schema version {version}"
                )));
            }
        }
        if version != Some(2) {
            transaction
                .execute_batch(
                    "ALTER TABLE assets ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE asset_versions ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;
                CREATE TABLE asset_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                CREATE TABLE asset_collection_entries (
                    asset_id TEXT NOT NULL REFERENCES assets(asset_id),
                    collection_id TEXT NOT NULL REFERENCES asset_collections(id) ON DELETE CASCADE,
                    PRIMARY KEY (asset_id, collection_id));
                UPDATE ash_schema_migrations SET version = 2 WHERE component = 'assets';",
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

impl AssetStore for SqliteAssetStore {
    fn catalog(&self) -> Result<Catalog, AssetError> {
        let mut connection = self.connection.lock().map_err(storage_error)?;
        // One read transaction keeps versions and membership in the same catalog snapshot.
        let transaction = connection.transaction().map_err(storage_error)?;
        let entries = {
            let mut statement = transaction.prepare("SELECT v.version_id, v.added_at, a.favorite FROM asset_versions v JOIN assets a ON a.asset_id = v.asset_id WHERE v.rowid = (SELECT max(latest.rowid) FROM asset_versions latest WHERE latest.asset_id = v.asset_id) ORDER BY v.rowid DESC").map_err(storage_error)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                })
                .map_err(storage_error)?;
            let mut entries = Vec::new();
            for row in rows {
                let (id, added_at, favorite) = row.map_err(storage_error)?;
                let version = find_version(&transaction, &id)?.ok_or(AssetError::NotFound)?;
                let mut membership = transaction.prepare("SELECT collection_id FROM asset_collection_entries WHERE asset_id = ?1 ORDER BY collection_id").map_err(storage_error)?;
                let collection_ids = membership
                    .query_map([&version.asset_id], |row| row.get(0))
                    .map_err(storage_error)?
                    .collect::<Result<Vec<String>, _>>()
                    .map_err(storage_error)?;
                entries.push(CatalogEntry {
                    version,
                    added_at,
                    favorite,
                    collection_ids,
                });
            }
            entries
        };
        let collections = {
            let mut statement = transaction
                .prepare("SELECT id, name FROM asset_collections ORDER BY name COLLATE NOCASE, id")
                .map_err(storage_error)?;
            statement
                .query_map([], |row| {
                    Ok(Collection {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                })
                .map_err(storage_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage_error)?
        };
        transaction.commit().map_err(storage_error)?;
        Ok(Catalog {
            entries,
            collections,
        })
    }

    fn update_entry(
        &self,
        asset_id: &str,
        favorite: bool,
        collection_ids: &[String],
    ) -> Result<(), AssetError> {
        let mut connection = self.connection.lock().map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if transaction
            .execute(
                "UPDATE assets SET favorite = ?1 WHERE asset_id = ?2",
                params![favorite, asset_id],
            )
            .map_err(storage_error)?
            == 0
        {
            return Err(AssetError::NotFound);
        }
        transaction
            .execute(
                "DELETE FROM asset_collection_entries WHERE asset_id = ?1",
                [asset_id],
            )
            .map_err(storage_error)?;
        for id in collection_ids {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM asset_collections WHERE id = ?1)",
                    [id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !exists {
                return Err(AssetError::NotFound);
            }
            transaction
                .execute(
                    "INSERT INTO asset_collection_entries VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                    params![asset_id, id],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)
    }

    fn create_collection(&self, collection: &Collection) -> Result<(), AssetError> {
        let connection = self.connection.lock().map_err(storage_error)?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT name FROM asset_collections WHERE id = ?1",
                [&collection.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some(name) = existing {
            return if name == collection.name {
                Ok(())
            } else {
                Err(AssetError::Conflict)
            };
        }
        connection
            .execute(
                "INSERT INTO asset_collections VALUES (?1, ?2)",
                params![collection.id, collection.name],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    fn delete_collection(&self, id: &str) -> Result<(), AssetError> {
        let connection = self.connection.lock().map_err(storage_error)?;
        if connection
            .execute("DELETE FROM asset_collections WHERE id = ?1", [id])
            .map_err(storage_error)?
            == 0
        {
            return Err(AssetError::NotFound);
        }
        Ok(())
    }

    fn publish(&self, version: &AssetVersion, bytes: &[u8]) -> Result<(), AssetError> {
        let mut connection = self.connection.lock().map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let existing = find_version(&transaction, &version.version_id)?;
        if let Some(existing) = existing {
            if existing != *version {
                return Err(AssetError::Conflict);
            }
            return Ok(());
        }
        transaction.execute("INSERT INTO asset_contents (sha256, bytes) VALUES (?1, ?2) ON CONFLICT(sha256) DO NOTHING", params![version.sha256, bytes]).map_err(storage_error)?;
        transaction
            .execute(
                "INSERT INTO assets (asset_id) VALUES (?1) ON CONFLICT(asset_id) DO NOTHING",
                [&version.asset_id],
            )
            .map_err(storage_error)?;
        transaction.execute("INSERT INTO asset_versions (version_id, asset_id, name, source, sha256, media_type, size, width, height, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CAST(strftime('%s', 'now') AS INTEGER) * 1000)", params![version.version_id, version.asset_id, version.name, version.source, version.sha256, version.media_type.as_str(), u32::try_from(version.size).map_err(storage_error)?, version.width, version.height]).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(())
    }

    fn get(&self, asset_id: &str, version_id: &str) -> Result<AssetVersion, AssetError> {
        let connection = self.connection.lock().map_err(storage_error)?;
        find_version(&connection, version_id)?
            .filter(|version| version.asset_id == asset_id)
            .ok_or(AssetError::NotFound)
    }

    fn read(
        &self,
        asset_id: &str,
        version_id: &str,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, AssetError> {
        let connection = self.connection.lock().map_err(storage_error)?;
        let version = find_version(&connection, version_id)?
            .filter(|version| version.asset_id == asset_id)
            .ok_or(AssetError::NotFound)?;
        if offset > version.size {
            return Err(AssetError::Invalid);
        }
        connection
            .query_row(
                "SELECT substr(bytes, ?1, ?2) FROM asset_contents WHERE sha256 = ?3",
                params![
                    u32::try_from(offset + 1).map_err(storage_error)?,
                    u32::try_from(length).map_err(storage_error)?,
                    version.sha256
                ],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }
}

fn find_version(
    connection: &Connection,
    version_id: &str,
) -> Result<Option<AssetVersion>, AssetError> {
    connection.query_row("SELECT asset_id, version_id, name, source, sha256, media_type, size, width, height FROM asset_versions WHERE version_id = ?1", [version_id], |row| Ok(AssetVersion {
        asset_id: row.get(0)?, version_id: row.get(1)?, name: row.get(2)?, source: row.get(3)?, sha256: row.get(4)?, media_type: assets::ImageType::from_mime(&row.get::<_, String>(5)?).ok_or_else(|| rusqlite::Error::InvalidColumnType(5, "media_type".into(), rusqlite::types::Type::Text))?, size: row.get::<_, u32>(6)? as usize, width: row.get(7)?, height: row.get(8)?,
    })).optional().map_err(storage_error)
}

fn storage_error(error: impl std::fmt::Display) -> AssetError {
    AssetError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
