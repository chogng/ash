use crate::SqliteDurability;
use crate::open_sqlite_database;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Reopening information independent of a product's windows or editor objects.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupWorkspace {
    pub id: String,
    pub folders: Vec<String>,
    pub configuration: Option<String>,
    pub remote_authority: Option<String>,
}

/// The format owner interprets content; State never constructs an editor or a draft.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupContent {
    pub resource: String,
    pub format: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupRecord {
    pub content: BackupContent,
    pub revision: String,
    pub updated_at: i64,
}

#[derive(Debug)]
pub enum BackupError {
    Invalid,
    Conflict,
    Storage(String),
}

impl fmt::Display for BackupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("invalid backup"),
            Self::Conflict => formatter.write_str("backup revision changed"),
            Self::Storage(detail) => formatter.write_str(detail),
        }
    }
}

impl std::error::Error for BackupError {}

/// Durable recovery content shared by all product connections in a profile.
/// Client namespaces separate incompatible recovery flows; revisions protect concurrent writers.
pub struct SqliteBackupStore {
    connection: Mutex<Connection>,
}

impl SqliteBackupStore {
    pub fn open(path: &Path) -> Result<Self, BackupError> {
        let mut connection =
            open_sqlite_database(path, SqliteDurability::Durable).map_err(BackupError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS ash_schema_migrations (component TEXT PRIMARY KEY, version INTEGER NOT NULL);",
        ).map_err(storage_error)?;
        let version: Option<u32> = transaction
            .query_row(
                "SELECT version FROM ash_schema_migrations WHERE component = 'backups'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        match version {
            None => transaction.execute_batch(
                "CREATE TABLE backup_workspaces (
                    client_id TEXT NOT NULL, workspace_id TEXT NOT NULL, descriptor TEXT NOT NULL,
                    PRIMARY KEY (client_id, workspace_id));
                CREATE TABLE backup_contents (
                    client_id TEXT NOT NULL, workspace_id TEXT NOT NULL, resource TEXT NOT NULL,
                    format TEXT NOT NULL, content TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL,
                    PRIMARY KEY (client_id, workspace_id, resource),
                    FOREIGN KEY (client_id, workspace_id) REFERENCES backup_workspaces(client_id, workspace_id) ON DELETE CASCADE);
                INSERT INTO ash_schema_migrations VALUES ('backups', 1);",
            ).map_err(storage_error)?,
            Some(1) => {}
            Some(version) => return Err(BackupError::Storage(format!("unsupported backup schema version {version}"))),
        }
        transaction.commit().map_err(storage_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn workspaces(&self, client_id: &str) -> Result<Vec<BackupWorkspace>, BackupError> {
        validate_id(client_id)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        let mut statement = connection.prepare(
            "SELECT descriptor FROM backup_workspaces w WHERE client_id = ?1
            AND EXISTS (SELECT 1 FROM backup_contents b WHERE b.client_id = w.client_id AND b.workspace_id = w.workspace_id)
            ORDER BY workspace_id",
        ).map_err(storage_error)?;
        let rows = statement
            .query_map([client_id], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.map(|row| serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error))
            .collect()
    }

    pub fn list(
        &self,
        client_id: &str,
        workspace_id: &str,
    ) -> Result<Vec<BackupRecord>, BackupError> {
        validate_id(client_id)?;
        validate_id(workspace_id)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        let mut statement = connection
            .prepare(
                "SELECT resource, format, content, revision, updated_at FROM backup_contents
            WHERE client_id = ?1 AND workspace_id = ?2 ORDER BY updated_at, resource",
            )
            .map_err(storage_error)?;
        statement
            .query_map(params![client_id, workspace_id], read_record)
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error))
            .collect()
    }

    /// None creates a record; updates must name the exact previously observed revision.
    pub fn write(
        &self,
        client_id: &str,
        workspace: &BackupWorkspace,
        content: &BackupContent,
        expected_revision: Option<&str>,
    ) -> Result<BackupRecord, BackupError> {
        validate_id(client_id)?;
        validate_id(&workspace.id)?;
        validate_id(&content.resource)?;
        validate_id(&content.format)?;
        for value in workspace
            .folders
            .iter()
            .chain(workspace.configuration.iter())
            .chain(workspace.remote_authority.iter())
        {
            validate_id(value)?;
        }
        if content.content.len() > 8 * 1024 * 1024 || workspace.folders.len() > 128 {
            return Err(BackupError::Invalid);
        }
        let mut connection = self.connection.lock().map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let current = transaction
            .query_row(
                "SELECT resource, format, content, revision, updated_at FROM backup_contents
            WHERE client_id = ?1 AND workspace_id = ?2 AND resource = ?3",
                params![client_id, workspace.id, content.resource],
                read_record,
            )
            .optional()
            .map_err(storage_error)?;
        // A lost write response can be reconciled without overwriting different recovery content.
        if let Some(current) = &current
            && current.content == *content
        {
            return Ok(current.clone());
        }
        if current.as_ref().map(|record| record.revision.as_str()) != expected_revision {
            return Err(BackupError::Conflict);
        }
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(storage_error)?;
        let revision = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let updated_at = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(storage_error)?
                .as_millis(),
        )
        .map_err(storage_error)?;
        let descriptor = serde_json::to_string(workspace).map_err(storage_error)?;
        transaction
            .execute(
                "INSERT INTO backup_workspaces VALUES (?1, ?2, ?3)
            ON CONFLICT(client_id, workspace_id) DO UPDATE SET descriptor = excluded.descriptor",
                params![client_id, workspace.id, descriptor],
            )
            .map_err(storage_error)?;
        transaction.execute(
            "INSERT INTO backup_contents VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(client_id, workspace_id, resource) DO UPDATE SET
            format = excluded.format, content = excluded.content, revision = excluded.revision, updated_at = excluded.updated_at",
            params![client_id, workspace.id, content.resource, content.format, content.content, revision, updated_at],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(BackupRecord {
            content: content.clone(),
            revision,
            updated_at,
        })
    }

    /// Removing a saved or reverted copy cannot discard a newer writer's recovery record.
    pub fn discard(
        &self,
        client_id: &str,
        workspace_id: &str,
        resource: &str,
        expected_revision: &str,
    ) -> Result<(), BackupError> {
        validate_id(client_id)?;
        validate_id(workspace_id)?;
        validate_id(resource)?;
        validate_id(expected_revision)?;
        let mut connection = self.connection.lock().map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let current: Option<String> = transaction.query_row(
            "SELECT revision FROM backup_contents WHERE client_id = ?1 AND workspace_id = ?2 AND resource = ?3",
            params![client_id, workspace_id, resource], |row| row.get(0),
        ).optional().map_err(storage_error)?;
        if let Some(current) = current
            && current != expected_revision
        {
            return Err(BackupError::Conflict);
        }
        transaction.execute(
            "DELETE FROM backup_contents WHERE client_id = ?1 AND workspace_id = ?2 AND resource = ?3",
            params![client_id, workspace_id, resource],
        ).map_err(storage_error)?;
        transaction.execute(
            "DELETE FROM backup_workspaces WHERE client_id = ?1 AND workspace_id = ?2
            AND NOT EXISTS (SELECT 1 FROM backup_contents WHERE client_id = ?1 AND workspace_id = ?2)",
            params![client_id, workspace_id],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }
}

fn validate_id(value: &str) -> Result<(), BackupError> {
    if value.trim().is_empty() || value.len() > 8192 || value.contains('\0') {
        return Err(BackupError::Invalid);
    }
    Ok(())
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<BackupRecord> {
    Ok(BackupRecord {
        content: BackupContent {
            resource: row.get(0)?,
            format: row.get(1)?,
            content: row.get(2)?,
        },
        revision: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn storage_error(error: impl fmt::Display) -> BackupError {
    BackupError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "backup_tests.rs"]
mod tests;
