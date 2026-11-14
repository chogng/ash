use ash_sqlite::Migration;
use ash_sqlite::Migrator;
use ash_sqlite::SqliteDurability;
use ash_sqlite::open_sqlite_database;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const MIGRATOR: Migrator<'_> = Migrator::new(
    "artifact-catalog",
    &[Migration::legacy_baseline(2, adopt_catalog)],
);

fn adopt_catalog(transaction: &rusqlite::Transaction<'_>, _: Option<u32>) -> Result<(), String> {
    transaction
        .execute_batch(include_str!("../migrations/0001_artifact_catalog.sql"))
        .map_err(|error| error.to_string())?;
    transaction.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS artifact_catalog_source ON artifact_catalog (client_id, provider_id, COALESCE(account_id, ''), session_id, thread_id, item_id, part_id);")
        .map_err(|error| error.to_string())
}

pub const NATIVE_ARTIFACT_CLIENT: &str = "ash-native";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactSource {
    pub provider_id: String,
    pub account_id: Option<String>,
    pub session_id: String,
    pub thread_id: String,
    pub item_id: String,
    pub part_id: String,
}

/// A reference to content already saved by its file-service owner. Neither this
/// descriptor nor its source grants permission to read or write the resource.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactRegistration {
    pub id: String,
    pub resource: String,
    pub title: String,
    pub content_type: String,
    pub source: ArtifactSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactRecord {
    pub file: ArtifactRegistration,
    /// Unix milliseconds assigned by the store on first registration.
    pub created_at: i64,
}

/// Retries preserve the first record, including its title and creation time.
pub enum ArtifactRegistrationOutcome {
    Created(ArtifactRecord),
    Existing(ArtifactRecord),
}

#[derive(Debug)]
pub enum ArtifactCatalogError {
    Invalid,
    Conflict,
    Storage(String),
}

impl fmt::Display for ArtifactCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("invalid artifact registration"),
            Self::Conflict => formatter.write_str("artifact identity conflicts"),
            Self::Storage(detail) => formatter.write_str(detail),
        }
    }
}

impl std::error::Error for ArtifactCatalogError {}

/// Profile-wide durable references, isolated by the UI storage namespace.
/// After publication, only the file provider owns the document body.
pub struct SqliteArtifactCatalog {
    connection: Mutex<Connection>,
    path: PathBuf,
}

impl SqliteArtifactCatalog {
    pub fn open(path: &Path) -> Result<Self, ArtifactCatalogError> {
        let mut connection = open_sqlite_database(path, SqliteDurability::Durable)
            .map_err(ArtifactCatalogError::Storage)?;
        MIGRATOR
            .run(&mut connection)
            .map_err(ArtifactCatalogError::Storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
            path: path.to_owned(),
        })
    }

    pub fn register(
        &self,
        client_id: &str,
        file: &ArtifactRegistration,
    ) -> Result<ArtifactRegistrationOutcome, ArtifactCatalogError> {
        validate_client_id(client_id)?;
        if client_id == NATIVE_ARTIFACT_CLIENT {
            return Err(ArtifactCatalogError::Invalid);
        }
        self.register_reference(client_id, file)
    }

    /// Registers an application's create-only native publication. External clients cannot
    /// select this namespace through `register`.
    pub fn register_native(
        &self,
        file: &ArtifactRegistration,
    ) -> Result<ArtifactRegistrationOutcome, ArtifactCatalogError> {
        if file.source.account_id.is_some() {
            return Err(ArtifactCatalogError::Invalid);
        }
        self.register_reference(NATIVE_ARTIFACT_CLIENT, file)
    }

    fn register_reference(
        &self,
        client_id: &str,
        file: &ArtifactRegistration,
    ) -> Result<ArtifactRegistrationOutcome, ArtifactCatalogError> {
        validate_registration(file)?;
        let mut connection = self.connection.lock().map_err(storage_error)?;
        // Separate store instances/processes share the same uniqueness and retry
        // decision; a Rust mutex alone cannot protect profile-wide registration.
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let source = &file.source;
        let created_at = unix_millis()?;
        let inserted = transaction
            .execute(
                "INSERT INTO artifact_catalog (client_id, id, resource, title, content_type,
             provider_id, account_id, session_id, thread_id, item_id, part_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT DO NOTHING",
                params![
                    client_id,
                    file.id,
                    file.resource,
                    file.title,
                    file.content_type,
                    source.provider_id,
                    source.account_id,
                    source.session_id,
                    source.thread_id,
                    source.item_id,
                    source.part_id,
                    created_at
                ],
            )
            .map_err(storage_error)?;
        if inserted == 0 {
            let current = transaction
                .query_row(
                    "SELECT id, resource, title, content_type, provider_id, account_id,
                     session_id, thread_id, item_id, part_id, created_at
                     FROM artifact_catalog WHERE client_id = ?1 AND id = ?2",
                    params![client_id, file.id],
                    read_record,
                )
                .optional()
                .map_err(storage_error)?;
            return match current {
                Some(current)
                    if current.file.resource == file.resource
                        && current.file.source == file.source =>
                {
                    Ok(ArtifactRegistrationOutcome::Existing(current))
                }
                _ => Err(ArtifactCatalogError::Conflict),
            };
        }
        transaction.commit().map_err(storage_error)?;
        Ok(ArtifactRegistrationOutcome::Created(ArtifactRecord {
            file: file.clone(),
            created_at,
        }))
    }

    /// The profile database is also used by domain-specific, one-way upgrade readers.
    pub fn database_path(&self) -> &Path {
        &self.path
    }

    pub fn native_resource(
        &self,
        id: &str,
    ) -> Result<Option<ArtifactRecord>, ArtifactCatalogError> {
        validate_file_id(id)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        connection.query_row(
            "SELECT id, resource, title, content_type, provider_id, account_id, session_id, thread_id, item_id, part_id, created_at FROM artifact_catalog WHERE client_id = ?1 AND id = ?2",
            params![NATIVE_ARTIFACT_CLIENT, id], read_record,
        ).optional().map_err(storage_error)
    }

    /// Returns native references and the current client's visible imports in one snapshot.
    /// The native namespace selects only native references.
    pub fn list(
        &self,
        client_id: &str,
        account_ids: &[String],
    ) -> Result<Vec<ArtifactRecord>, ArtifactCatalogError> {
        validate_client_id(client_id)?;
        if account_ids.len() > 64 {
            return Err(ArtifactCatalogError::Invalid);
        }
        for account in account_ids {
            validate_text(account, 1024)?;
        }
        let accounts = serde_json::to_string(account_ids).map_err(storage_error)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, resource, title, content_type, provider_id, account_id,
             session_id, thread_id, item_id, part_id, created_at FROM artifact_catalog
             WHERE client_id = ?1 OR (
                 client_id = ?2 AND (account_id IS NULL OR account_id IN (SELECT value FROM json_each(?3)))
                 AND NOT EXISTS (
                     SELECT 1 FROM artifact_catalog native WHERE native.client_id = ?1 AND native.id = artifact_catalog.id
                 )
             )
             ORDER BY client_id = ?1 DESC, created_at DESC, id",
            )
            .map_err(storage_error)?;
        statement
            .query_map(
                params![NATIVE_ARTIFACT_CLIENT, client_id, accounts],
                read_record,
            )
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error))
            .collect()
    }
}

fn unix_millis() -> Result<i64, ArtifactCatalogError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(storage_error)?
            .as_millis(),
    )
    .map_err(storage_error)
}

fn validate_client_id(client_id: &str) -> Result<(), ArtifactCatalogError> {
    validate_text(client_id, 1024)
}

fn validate_file_id(id: &str) -> Result<(), ArtifactCatalogError> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(ArtifactCatalogError::Invalid)
    }
}

fn validate_registration(file: &ArtifactRegistration) -> Result<(), ArtifactCatalogError> {
    validate_file_id(&file.id)?;
    validate_text(&file.resource, 16384)?;
    validate_text(&file.title, 4096)?;
    validate_text(&file.content_type, 256)?;
    validate_text(&file.source.provider_id, 256)?;
    if let Some(account_id) = &file.source.account_id {
        validate_text(account_id, 1024)?;
    }
    for value in [
        &file.source.session_id,
        &file.source.thread_id,
        &file.source.item_id,
        &file.source.part_id,
    ] {
        validate_text(value, 8192)?;
    }
    Ok(())
}

fn validate_text(value: &str, maximum_bytes: usize) -> Result<(), ArtifactCatalogError> {
    if value.trim().is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control)
    {
        return Err(ArtifactCatalogError::Invalid);
    }
    Ok(())
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactRecord> {
    Ok(ArtifactRecord {
        file: ArtifactRegistration {
            id: row.get(0)?,
            resource: row.get(1)?,
            title: row.get(2)?,
            content_type: row.get(3)?,
            source: ArtifactSource {
                provider_id: row.get(4)?,
                account_id: row.get(5)?,
                session_id: row.get(6)?,
                thread_id: row.get(7)?,
                item_id: row.get(8)?,
                part_id: row.get(9)?,
            },
        },
        created_at: row.get(10)?,
    })
}

fn storage_error(error: impl fmt::Display) -> ArtifactCatalogError {
    ArtifactCatalogError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
