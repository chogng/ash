use crate::ConfigError;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

const CONFIG_SQLITE_SCHEMA_VERSION: u32 = 2;

pub(crate) struct LegacyDocument {
    pub schema_version: u32,
    pub document_json: String,
}

pub(crate) fn initialize(
    connection: &mut Connection,
    document_schema_version: u32,
    initial_digest: &str,
) -> Result<Option<LegacyDocument>, ConfigError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                 component TEXT PRIMARY KEY,
                 version INTEGER NOT NULL
             );",
        )
        .map_err(sql_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let stored_version = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = 'config'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .optional()
        .map_err(sql_error)?;
    let legacy = match stored_version {
        None => {
            install_fresh(&transaction, document_schema_version, initial_digest)?;
            None
        }
        Some(CONFIG_SQLITE_SCHEMA_VERSION) => {
            upgrade_document_schema(&transaction, document_schema_version, initial_digest)?;
            None
        }
        Some(1) => Some(migrate_v1(
            &transaction,
            document_schema_version,
            initial_digest,
        )?),
        Some(version) => {
            return Err(ConfigError(format!(
                "unsupported config SQLite schema version {version}"
            )));
        }
    };
    transaction.commit().map_err(sql_error)?;
    Ok(legacy)
}

fn install_fresh(
    connection: &Connection,
    document_schema_version: u32,
    initial_digest: &str,
) -> Result<(), ConfigError> {
    connection
        .execute_batch(
            "CREATE TABLE config_metadata (
                 authority_id INTEGER PRIMARY KEY CHECK (authority_id = 1),
                 document_schema_version INTEGER NOT NULL,
                 revision INTEGER NOT NULL,
                 generation INTEGER NOT NULL,
                 content_digest TEXT NOT NULL
             );
             CREATE TABLE config_command_receipts (
                 command_id TEXT PRIMARY KEY,
                 expected_revision INTEGER NOT NULL,
                 command_json TEXT NOT NULL,
                 result_revision INTEGER NOT NULL,
                 result_generation INTEGER NOT NULL
             );",
        )
        .map_err(sql_error)?;
    connection
        .execute(
            "INSERT INTO config_metadata
             (authority_id, document_schema_version, revision, generation, content_digest)
             VALUES (1, ?1, 0, 0, ?2)",
            params![document_schema_version, initial_digest],
        )
        .map_err(sql_error)?;
    connection
        .execute(
            "INSERT INTO ash_schema_migrations (component, version) VALUES ('config', ?1)",
            [CONFIG_SQLITE_SCHEMA_VERSION],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn upgrade_document_schema(
    connection: &Connection,
    document_schema_version: u32,
    initial_digest: &str,
) -> Result<(), ConfigError> {
    let stored_version = connection
        .query_row(
            "SELECT document_schema_version FROM config_metadata WHERE authority_id = 1",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(sql_error)?;
    if stored_version == document_schema_version {
        return Ok(());
    }
    if stored_version > document_schema_version
        || stored_version < crate::store::OLDEST_SUPPORTED_CONFIG_DOCUMENT_SCHEMA_VERSION
    {
        return Err(ConfigError(format!(
            "unsupported config document schema version {stored_version}"
        )));
    }
    connection
        .execute(
            "UPDATE config_metadata
             SET document_schema_version = ?1, content_digest = ?2
             WHERE authority_id = 1",
            params![document_schema_version, initial_digest],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn migrate_v1(
    connection: &Connection,
    document_schema_version: u32,
    initial_digest: &str,
) -> Result<LegacyDocument, ConfigError> {
    let legacy = connection
        .query_row(
            "SELECT schema_version, revision, generation, document_json
             FROM config_authority WHERE authority_id = 1",
            [],
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
    if legacy.0 > document_schema_version
        || legacy.0 < crate::store::OLDEST_SUPPORTED_CONFIG_DOCUMENT_SCHEMA_VERSION
    {
        return Err(ConfigError(format!(
            "unsupported config document schema version {}",
            legacy.0
        )));
    }
    connection
        .execute_batch(
            "CREATE TABLE config_metadata (
                 authority_id INTEGER PRIMARY KEY CHECK (authority_id = 1),
                 document_schema_version INTEGER NOT NULL,
                 revision INTEGER NOT NULL,
                 generation INTEGER NOT NULL,
                 content_digest TEXT NOT NULL
             );",
        )
        .map_err(sql_error)?;
    connection
        .execute(
            "INSERT INTO config_metadata
             (authority_id, document_schema_version, revision, generation, content_digest)
             VALUES (1, ?1, ?2, ?3, ?4)",
            params![document_schema_version, legacy.1, legacy.2, initial_digest],
        )
        .map_err(sql_error)?;
    connection
        .execute_batch("DROP TABLE config_authority;")
        .map_err(sql_error)?;
    connection
        .execute(
            "UPDATE ash_schema_migrations SET version = ?1 WHERE component = 'config'",
            [CONFIG_SQLITE_SCHEMA_VERSION],
        )
        .map_err(sql_error)?;
    Ok(LegacyDocument {
        schema_version: legacy.0,
        document_json: legacy.3,
    })
}

fn sql_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError(format!("config SQLite schema error: {error}"))
}
