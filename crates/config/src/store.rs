use crate::{
    ConfigCommandDisposition, ConfigCommandError, ConfigCommandRequest, ConfigCommandResult,
    ConfigGeneration, ConfigRevision, ResolvedConfigSnapshot, UserConfigCommand,
    UserConfigDocument,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

const CONFIG_DOCUMENT_SCHEMA_VERSION: u32 = 10;
pub(crate) const OLDEST_SUPPORTED_CONFIG_DOCUMENT_SCHEMA_VERSION: u32 = 7;
const CONFIG_AUTHORITY_ID: i64 = 1;

/// Failure while loading, validating, or persisting the user configuration authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// TOML-backed user configuration with SQLite transaction metadata and exact command receipts.
///
/// `config_path` is the only desired-document authority. SQLite serializes API writers and owns
/// revision, generation, and retry receipts, but never stores a second editable document.
pub struct ConfigStore {
    database_path: PathBuf,
    config_path: PathBuf,
    connection: Mutex<Connection>,
    subscribers: Arc<Mutex<Vec<Sender<ConfigChange>>>>,
    committed: Arc<Mutex<ResolvedConfigSnapshot>>,
    monitor_shutdown: Option<Sender<()>>,
    monitor_thread: Option<JoinHandle<()>>,
}

struct ConfigAuthority {
    schema_version: u32,
    revision: ConfigRevision,
    generation: ConfigGeneration,
    content_digest: String,
    document: UserConfigDocument,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigCommandReceipt {
    expected_revision: ConfigRevision,
    command: UserConfigCommand,
    result_revision: ConfigRevision,
    result_generation: ConfigGeneration,
}

/// One observed user-configuration change published after its metadata transaction completes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConfigChange {
    pub revision: ConfigRevision,
    pub generation: ConfigGeneration,
}

impl ConfigStore {
    /// Opens `database_path` and uses the same filename with a `.toml` extension as config.
    ///
    /// Composition roots should prefer [`Self::open_with_paths`] so both durability locations are
    /// explicit. This convenience form keeps tests and small embedders concise.
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, ConfigError> {
        let database_path = database_path.into();
        let config_path = database_path.with_extension("toml");
        Self::open_with_paths(database_path, config_path)
    }

    /// Opens one TOML desired-document authority plus its SQLite transaction metadata.
    pub fn open_with_paths(
        database_path: impl Into<PathBuf>,
        config_path: impl Into<PathBuf>,
    ) -> Result<Self, ConfigError> {
        let database_path = database_path.into();
        let config_path = config_path.into();
        if let Some(parent) = database_path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let config_existed = config_path.exists();
        let mut document = read_document_and_migrate(&config_path)?;
        let initial_digest = crate::store_file::document_digest(&document)?;

        let mut connection =
            ash_state::open_sqlite_database(&database_path, ash_state::SqliteDurability::Durable)
                .map_err(ConfigError)?;
        let legacy = crate::store_schema::initialize(
            &mut connection,
            CONFIG_DOCUMENT_SCHEMA_VERSION,
            &initial_digest,
        )?;
        if let Some(legacy) = legacy
            && !config_existed
        {
            if !(OLDEST_SUPPORTED_CONFIG_DOCUMENT_SCHEMA_VERSION..=CONFIG_DOCUMENT_SCHEMA_VERSION)
                .contains(&legacy.schema_version)
            {
                return Err(ConfigError(format!(
                    "unsupported config document schema version {}",
                    legacy.schema_version
                )));
            }
            document = crate::document_migration::decode_legacy_json(&legacy.document_json)?;
            document.validate()?;
            crate::store_file::write_document(&config_path, &document)?;
            replace_content_digest(&connection, &crate::store_file::document_digest(&document)?)?;
        } else if !config_path.exists() {
            crate::store_file::write_document(&config_path, &document)?;
        }

        let (authority, _) = synchronize_authority(&mut connection, &config_path)?;
        let subscribers = Arc::new(Mutex::new(Vec::new()));
        let committed = Arc::new(Mutex::new(authority.snapshot()));
        let (monitor_shutdown, monitor_receiver) = mpsc::channel();
        let monitor_connection =
            ash_state::open_sqlite_database(&database_path, ash_state::SqliteDurability::Durable)
                .map_err(ConfigError)?;
        let monitor_thread = crate::store_monitor::start(
            monitor_connection,
            config_path.clone(),
            monitor_receiver,
            Arc::clone(&subscribers),
            Arc::clone(&committed),
        )?;
        Ok(Self {
            database_path,
            config_path,
            connection: Mutex::new(connection),
            subscribers,
            committed,
            monitor_shutdown: Some(monitor_shutdown),
            monitor_thread: Some(monitor_thread),
        })
    }

    /// Reads the current immutable snapshot, reconciling valid external TOML edits first.
    pub fn read_snapshot(&self) -> Result<ResolvedConfigSnapshot, ConfigError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ConfigError("config database lock poisoned".into()))?;
        let (authority, _) = synchronize_authority(&mut connection, &self.config_path)?;
        drop(connection);
        let snapshot = authority.snapshot();
        self.publish_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    /// Returns the accepted runtime configuration without reading an uncommitted file edit.
    ///
    /// Invalid TOML remains an error for strict reads and commands. It cannot replace this
    /// snapshot or prevent independent runtime authorities from applying their own changes.
    pub fn committed_snapshot(&self) -> ResolvedConfigSnapshot {
        self.committed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Subscribes to committed API changes and valid external TOML edits.
    pub fn subscribe_changes(&self) -> Receiver<ConfigChange> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(sender);
        receiver
    }

    /// Applies one retry-safe typed command at its expected observed revision.
    pub fn apply(
        &self,
        request: ConfigCommandRequest,
    ) -> Result<ConfigCommandResult, ConfigCommandError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ConfigError("config database lock poisoned".into()))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;

        if let Some(receipt) = read_receipt(&transaction, request.command_id.as_str())? {
            if receipt.expected_revision != request.expected_revision
                || receipt.command != request.command
            {
                return Err(ConfigCommandError::CommandConflict);
            }
            return Ok(ConfigCommandResult {
                revision: receipt.result_revision,
                generation: receipt.result_generation,
                disposition: ConfigCommandDisposition::Replayed,
            });
        }

        let (mut authority, externally_changed) = read_authority(&transaction, &self.config_path)?;
        if externally_changed {
            authority.revision = authority.revision.next();
            authority.generation = authority.generation.next();
            write_metadata(&transaction, &authority)?;
            transaction.commit().map_err(sql_error)?;
            drop(connection);
            self.publish_snapshot(authority.snapshot());
            return Err(ConfigCommandError::RevisionConflict {
                expected: request.expected_revision,
                actual: authority.revision,
            });
        }
        if request.expected_revision != authority.revision {
            return Err(ConfigCommandError::RevisionConflict {
                expected: request.expected_revision,
                actual: authority.revision,
            });
        }

        let document_before = authority.document.clone();
        crate::mutation::apply_command(&mut authority.document, &request.command)?;
        authority.document.validate()?;
        let changed = authority.document != document_before;
        if changed {
            crate::store_file::write_document_if_unchanged(
                &self.config_path,
                &authority.content_digest,
                &authority.document,
            )?;
            authority.content_digest = crate::store_file::document_digest(&authority.document)?;
            authority.revision = authority.revision.next();
            authority.generation = authority.generation.next();
            write_metadata(&transaction, &authority)?;
        }
        write_receipt(
            &transaction,
            request.command_id.as_str(),
            &ConfigCommandReceipt {
                expected_revision: request.expected_revision,
                command: request.command,
                result_revision: authority.revision,
                result_generation: authority.generation,
            },
        )?;
        transaction.commit().map_err(sql_error)?;
        let result = ConfigCommandResult {
            revision: authority.revision,
            generation: authority.generation,
            disposition: ConfigCommandDisposition::Updated,
        };
        drop(connection);
        self.publish_snapshot(authority.snapshot());
        Ok(result)
    }

    /// Returns the SQLite metadata and receipt database path.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Returns the TOML desired-document authority path.
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    fn publish_snapshot(&self, snapshot: ResolvedConfigSnapshot) {
        crate::store_monitor::publish(&self.subscribers, &self.committed, snapshot);
    }
}

impl Drop for ConfigStore {
    fn drop(&mut self) {
        if let Some(shutdown) = self.monitor_shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.monitor_thread.take() {
            let _ = thread.join();
        }
    }
}

impl ConfigAuthority {
    fn snapshot(&self) -> ResolvedConfigSnapshot {
        ResolvedConfigSnapshot::from_document(self.revision, self.generation, &self.document)
    }
}

pub(crate) fn reconcile_external_snapshot(
    connection: &mut Connection,
    config_path: &Path,
) -> Result<ResolvedConfigSnapshot, ConfigError> {
    let (authority, _) = synchronize_authority(connection, config_path)?;
    Ok(authority.snapshot())
}

fn synchronize_authority(
    connection: &mut Connection,
    config_path: &Path,
) -> Result<(ConfigAuthority, bool), ConfigError> {
    let (authority, changed) = read_authority(connection, config_path)?;
    if !changed {
        return Ok((authority, false));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let (mut authority, changed) = read_authority(&transaction, config_path)?;
    if changed {
        authority.revision = authority.revision.next();
        authority.generation = authority.generation.next();
        write_metadata(&transaction, &authority)?;
    }
    transaction.commit().map_err(sql_error)?;
    Ok((authority, changed))
}

fn read_authority(
    connection: &Connection,
    config_path: &Path,
) -> Result<(ConfigAuthority, bool), ConfigError> {
    let metadata = connection
        .query_row(
            "SELECT document_schema_version, revision, generation, content_digest
             FROM config_metadata WHERE authority_id = ?1",
            [CONFIG_AUTHORITY_ID],
            |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(sql_error)?;
    if metadata.0 != CONFIG_DOCUMENT_SCHEMA_VERSION {
        return Err(ConfigError(format!(
            "unsupported config document schema version {}",
            metadata.0
        )));
    }
    let document = read_document_and_migrate(config_path)?;
    let content_digest = crate::store_file::document_digest(&document)?;
    let changed = content_digest != metadata.3;
    Ok((
        ConfigAuthority {
            schema_version: metadata.0,
            revision: ConfigRevision::new(from_sql_integer(metadata.1)?),
            generation: ConfigGeneration::new(from_sql_integer(metadata.2)?),
            content_digest,
            document,
        },
        changed,
    ))
}

fn read_document_and_migrate(config_path: &Path) -> Result<UserConfigDocument, ConfigError> {
    crate::store_file::read_document(config_path)
}

fn write_metadata(connection: &Connection, authority: &ConfigAuthority) -> Result<(), ConfigError> {
    connection
        .execute(
            "UPDATE config_metadata
             SET document_schema_version = ?2, revision = ?3, generation = ?4,
                 content_digest = ?5
             WHERE authority_id = ?1",
            params![
                CONFIG_AUTHORITY_ID,
                authority.schema_version,
                to_sql_integer(authority.revision.get())?,
                to_sql_integer(authority.generation.get())?,
                authority.content_digest,
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn replace_content_digest(connection: &Connection, digest: &str) -> Result<(), ConfigError> {
    connection
        .execute(
            "UPDATE config_metadata SET content_digest = ?1 WHERE authority_id = ?2",
            params![digest, CONFIG_AUTHORITY_ID],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn read_receipt(
    connection: &Connection,
    command_id: &str,
) -> Result<Option<ConfigCommandReceipt>, ConfigError> {
    let receipt = connection
        .query_row(
            "SELECT expected_revision, command_json, result_revision, result_generation
             FROM config_command_receipts WHERE command_id = ?1",
            [command_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(sql_error)?;
    receipt
        .map(
            |(expected_revision, command, result_revision, result_generation)| {
                Ok(ConfigCommandReceipt {
                    expected_revision: ConfigRevision::new(from_sql_integer(expected_revision)?),
                    command: serde_json::from_str(&command).map_err(|error| {
                        ConfigError(format!("invalid config command receipt: {error}"))
                    })?,
                    result_revision: ConfigRevision::new(from_sql_integer(result_revision)?),
                    result_generation: ConfigGeneration::new(from_sql_integer(result_generation)?),
                })
            },
        )
        .transpose()
}

fn write_receipt(
    connection: &Connection,
    command_id: &str,
    receipt: &ConfigCommandReceipt,
) -> Result<(), ConfigError> {
    connection
        .execute(
            "INSERT INTO config_command_receipts
             (command_id, expected_revision, command_json, result_revision, result_generation)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                command_id,
                to_sql_integer(receipt.expected_revision.get())?,
                serde_json::to_string(&receipt.command)
                    .map_err(|error| ConfigError(error.to_string()))?,
                to_sql_integer(receipt.result_revision.get())?,
                to_sql_integer(receipt.result_generation.get())?,
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn to_sql_integer(value: u64) -> Result<i64, ConfigError> {
    i64::try_from(value).map_err(|_| ConfigError("configuration revision overflow".into()))
}

fn from_sql_integer(value: i64) -> Result<u64, ConfigError> {
    u64::try_from(value).map_err(|_| ConfigError("negative configuration revision".into()))
}

fn io_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError(error.to_string())
}

fn sql_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError(format!("config SQLite error: {error}"))
}
