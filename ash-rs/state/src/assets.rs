use crate::SqliteDurability;
use crate::open_sqlite_database;
use assets::AssetError;
use assets::AssetStore;
use assets::AssetVersion;
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
            Some(1) => {}
            Some(version) => {
                return Err(AssetError::Storage(format!(
                    "unsupported asset schema version {version}"
                )));
            }
        }
        transaction.commit().map_err(storage_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

impl AssetStore for SqliteAssetStore {
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
        transaction.execute("INSERT INTO asset_versions (version_id, asset_id, name, source, sha256, media_type, size, width, height) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![version.version_id, version.asset_id, version.name, version.source, version.sha256, version.media_type.as_str(), u32::try_from(version.size).map_err(storage_error)?, version.width, version.height]).map_err(storage_error)?;
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
