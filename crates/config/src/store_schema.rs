use crate::ConfigError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

const BASELINE_VERSION: u32 = 2;
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0002_config_metadata.sql")];

struct LegacyDocument {
    schema_version: u32,
    revision: i64,
    generation: i64,
    json: String,
}

pub(crate) fn initialize(
    connection: &mut Connection,
    document_schema_version: u32,
    prepare_document: impl FnOnce(Option<&str>) -> Result<String, ConfigError>,
) -> Result<(), ConfigError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                 component TEXT PRIMARY KEY,
                 version INTEGER NOT NULL
             );",
        )
        .map_err(sql_error)?;
    let stored_version: Option<u32> = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = 'config'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let latest = BASELINE_VERSION + MIGRATIONS.len() as u32 - 1;
    if let Some(version) = stored_version
        && !(1..=latest).contains(&version)
    {
        return Err(ConfigError(format!(
            "unsupported config SQLite schema version {version}"
        )));
    }
    let legacy = if stored_version == Some(1) {
        Some(read_legacy(&transaction, document_schema_version)?)
    } else {
        None
    };
    let stored_document_version =
        if stored_version.is_some_and(|version| version >= BASELINE_VERSION) {
            let version = transaction
                .query_row(
                    "SELECT document_schema_version FROM config_metadata WHERE authority_id = 1",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .map_err(sql_error)?;
            validate_document_schema_version(version, document_schema_version)?;
            Some(version)
        } else {
            None
        };

    // Publish the TOML before deleting its legacy SQLite source. Other openers wait
    // here, and a failed file write leaves the old database available for retry.
    let digest = prepare_document(legacy.as_ref().map(|legacy| legacy.json.as_str()))?;
    for (version, sql) in (BASELINE_VERSION..)
        .zip(MIGRATIONS)
        .filter(|(version, _)| stored_version.is_none_or(|stored| *version > stored))
    {
        transaction.execute_batch(sql).map_err(sql_error)?;
        if version == BASELINE_VERSION {
            install_metadata(
                &transaction,
                document_schema_version,
                &digest,
                legacy.as_ref(),
            )?;
        }
        transaction
            .execute(
                "INSERT INTO ash_schema_migrations (component, version) VALUES ('config', ?1)
                 ON CONFLICT(component) DO UPDATE SET version = excluded.version",
                [version],
            )
            .map_err(sql_error)?;
    }
    if let Some(stored_version) = stored_document_version {
        upgrade_document_schema(
            &transaction,
            stored_version,
            document_schema_version,
            &digest,
        )?;
    }
    transaction.commit().map_err(sql_error)
}

fn install_metadata(
    transaction: &Transaction<'_>,
    document_schema_version: u32,
    digest: &str,
    legacy: Option<&LegacyDocument>,
) -> Result<(), ConfigError> {
    let (revision, generation) =
        legacy.map_or((0, 0), |legacy| (legacy.revision, legacy.generation));
    transaction
        .execute(
            "INSERT INTO config_metadata
             (authority_id, document_schema_version, revision, generation, content_digest)
             VALUES (1, ?1, ?2, ?3, ?4)",
            params![document_schema_version, revision, generation, digest],
        )
        .map_err(sql_error)?;
    if let Some(legacy) = legacy {
        if legacy.schema_version < 11 {
            migrate_directory_grant_receipts(transaction)?;
        }
        transaction
            .execute_batch(include_str!(
                "../migrations/legacy/remove_config_authority.sql"
            ))
            .map_err(sql_error)?;
    }
    Ok(())
}

fn upgrade_document_schema(
    connection: &Connection,
    stored_version: u32,
    document_schema_version: u32,
    initial_digest: &str,
) -> Result<(), ConfigError> {
    if stored_version == document_schema_version {
        return Ok(());
    }
    if stored_version < 11 {
        migrate_directory_grant_receipts(connection)?;
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

fn read_legacy(
    transaction: &Transaction<'_>,
    document_schema_version: u32,
) -> Result<LegacyDocument, ConfigError> {
    let legacy = transaction
        .query_row(
            "SELECT schema_version, revision, generation, document_json
             FROM config_authority WHERE authority_id = 1",
            [],
            |row| {
                Ok(LegacyDocument {
                    schema_version: row.get(0)?,
                    revision: row.get(1)?,
                    generation: row.get(2)?,
                    json: row.get(3)?,
                })
            },
        )
        .map_err(sql_error)?;
    validate_document_schema_version(legacy.schema_version, document_schema_version)?;
    Ok(legacy)
}

fn validate_document_schema_version(version: u32, current: u32) -> Result<(), ConfigError> {
    if !(crate::store::OLDEST_SUPPORTED_CONFIG_DOCUMENT_SCHEMA_VERSION..=current).contains(&version)
    {
        return Err(ConfigError(format!(
            "unsupported config document schema version {version}"
        )));
    }
    Ok(())
}

// Receipts keep their exact command identity and revisions while using current tags.
fn migrate_directory_grant_receipts(connection: &Connection) -> Result<(), ConfigError> {
    connection
        .execute_batch(include_str!(
            "../migrations/legacy/directory_grant_receipts.sql"
        ))
        .map_err(sql_error)
}

fn sql_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError(format!("config SQLite schema error: {error}"))
}
