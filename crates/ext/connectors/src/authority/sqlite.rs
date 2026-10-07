use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;

use crate::ConnectorAccount;
use crate::ConnectorAccountId;
use crate::ConnectorConnection;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorConnectionState;
use crate::ConnectorCredentialRef;
use crate::ConnectorDefinition;
use crate::ConnectorDefinitionDigest;
use crate::ConnectorEntry;
use crate::ConnectorId;
use crate::ConnectorSnapshot;
use crate::ConnectorSnapshotGeneration;
use rusqlite::Connection;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use super::AuthorityEvent;
use super::CommandReceipt;
use super::domain_error;
use super::persistence_error;
use crate::ConnectorAuthorityError;

pub(super) struct LoadedAuthority {
    pub authority: SqliteAuthority,
    pub snapshot: ConnectorSnapshot,
    pub receipts: BTreeMap<String, CommandReceipt>,
    pub credential_cleanup_pending: BTreeSet<ConnectorId>,
}

pub(super) struct SqliteAuthority {
    connection: Mutex<Connection>,
}

impl SqliteAuthority {
    pub fn open(
        path: &Path,
        definitions: Vec<ConnectorDefinition>,
    ) -> Result<LoadedAuthority, ConnectorAuthorityError> {
        let connection =
            ash_state::open_sqlite_database(path, ash_state::SqliteDurability::Durable)
                .map_err(|error| persistence_error(error.to_string()))?;
        initialize(&connection)?;
        let records = load_latest_records(&connection)?;
        let max_generation = records
            .values()
            .map(|record| record.snapshot_generation)
            .max()
            .unwrap_or(1)
            .max(load_generation(&connection)?);
        let mut entries = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let connection = match records.get(definition.id()) {
                Some(record) => record.restore(&definition)?,
                None => ConnectorConnection::disconnected(),
            };
            entries.push(ConnectorEntry::restore(definition, connection));
        }
        let snapshot =
            ConnectorSnapshot::restore(ConnectorSnapshotGeneration::new(max_generation), entries)
                .map_err(domain_error)?;
        let receipts = load_receipts(&connection)?;
        let credential_cleanup_pending = load_credential_cleanup(&connection)?;
        Ok(LoadedAuthority {
            authority: Self {
                connection: Mutex::new(connection),
            },
            snapshot,
            receipts,
            credential_cleanup_pending,
        })
    }

    pub fn persist(
        &self,
        event: &AuthorityEvent,
        result_generation: ConnectorSnapshotGeneration,
        command_id: &str,
        receipt: &CommandReceipt,
    ) -> Result<(), ConnectorAuthorityError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| persistence_error("connector SQLite lock poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        insert_event(&transaction, event, result_generation)?;
        match event {
            AuthorityEvent::Disconnect { connector_id, .. } => {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO connector_credential_cleanup (connector_id) VALUES (?1)",
                        [connector_id.as_str()],
                    )
                    .map_err(sql_error)?;
            }
            AuthorityEvent::Complete { connector_id, .. } => {
                transaction
                    .execute(
                        "DELETE FROM connector_credential_cleanup WHERE connector_id = ?1",
                        [connector_id.as_str()],
                    )
                    .map_err(sql_error)?;
            }
            AuthorityEvent::Begin { .. } | AuthorityEvent::Unavailable { .. } => {}
        }
        transaction
            .execute(
                "INSERT INTO connector_command_receipts (
                    command_id, expected_generation, connector_id, command_digest,
                    result_generation
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    command_id,
                    to_i64(receipt.expected_generation.get())?,
                    receipt.connector_id.as_str(),
                    receipt.command_digest,
                    to_i64(receipt.result_generation.get())?,
                ],
            )
            .map_err(sql_error)?;
        update_generation(&transaction, result_generation)?;
        transaction.commit().map_err(sql_error)
    }

    pub fn persist_generation(
        &self,
        generation: ConnectorSnapshotGeneration,
    ) -> Result<(), ConnectorAuthorityError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| persistence_error("connector SQLite lock poisoned"))?;
        connection
            .execute(
                "UPDATE connector_authority_meta SET snapshot_generation = ?1 WHERE singleton = 1",
                [to_i64(generation.get())?],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    pub fn restore_connections(
        &self,
        definitions: &[ConnectorDefinition],
    ) -> Result<BTreeMap<ConnectorId, ConnectorConnection>, ConnectorAuthorityError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| persistence_error("connector SQLite lock poisoned"))?;
        let records = load_latest_records(&connection)?;
        definitions
            .iter()
            .filter_map(|definition| {
                records.get(definition.id()).map(|record| {
                    record
                        .restore(definition)
                        .map(|connection| (definition.id().clone(), connection))
                })
            })
            .collect()
    }

    pub fn clear_credential_cleanup(
        &self,
        connector_id: &ConnectorId,
    ) -> Result<(), ConnectorAuthorityError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| persistence_error("connector SQLite lock poisoned"))?;
        connection
            .execute(
                "DELETE FROM connector_credential_cleanup WHERE connector_id = ?1",
                [connector_id.as_str()],
            )
            .map_err(sql_error)?;
        Ok(())
    }
}

struct PersistedRecord {
    snapshot_generation: u64,
    event: AuthorityEvent,
}

impl PersistedRecord {
    fn restore(
        &self,
        definition: &ConnectorDefinition,
    ) -> Result<ConnectorConnection, ConnectorAuthorityError> {
        let (generation, state) = match &self.event {
            AuthorityEvent::Begin { generation, .. } => (
                *generation,
                ConnectorConnectionState::Unavailable {
                    reason: "Connector authorization was interrupted".into(),
                },
            ),
            AuthorityEvent::Complete {
                account,
                definition_digest,
                ..
            } => {
                let state = if definition.digest() == *definition_digest {
                    ConnectorConnectionState::Connected(account.clone())
                } else {
                    ConnectorConnectionState::ReauthorizationRequired {
                        account: account.clone(),
                        previous_definition: definition_digest.clone(),
                    }
                };
                (account.connection_generation(), state)
            }
            AuthorityEvent::Unavailable {
                generation, reason, ..
            } => (
                *generation,
                ConnectorConnectionState::Unavailable {
                    reason: reason.clone(),
                },
            ),
            AuthorityEvent::Disconnect { generation, .. } => {
                (*generation, ConnectorConnectionState::Disconnected)
            }
        };
        ConnectorConnection::restore(generation, state).map_err(domain_error)
    }
}

fn initialize(connection: &Connection) -> Result<(), ConnectorAuthorityError> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS connector_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_generation INTEGER NOT NULL UNIQUE,
                connector_id TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                connection_generation INTEGER NOT NULL,
                account_id TEXT,
                account_display_name TEXT,
                credential_reference TEXT,
                definition_digest TEXT,
                reason TEXT
             );
             CREATE TABLE IF NOT EXISTS connector_command_receipts (
                command_id TEXT PRIMARY KEY,
                expected_generation INTEGER NOT NULL,
                connector_id TEXT NOT NULL,
                command_digest TEXT NOT NULL,
                result_generation INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS connector_authority_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                snapshot_generation INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS connector_credential_cleanup (
                connector_id TEXT PRIMARY KEY
             );
             INSERT OR IGNORE INTO connector_authority_meta (singleton, snapshot_generation)
             VALUES (1, 1);",
        )
        .map_err(sql_error)
}

fn load_credential_cleanup(
    connection: &Connection,
) -> Result<BTreeSet<ConnectorId>, ConnectorAuthorityError> {
    let mut statement = connection
        .prepare("SELECT connector_id FROM connector_credential_cleanup ORDER BY connector_id")
        .map_err(sql_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql_error)?;
    rows.map(|row| {
        ConnectorId::new(row.map_err(sql_error)?)
            .map_err(|_| persistence_error("persisted connector cleanup identity is invalid"))
    })
    .collect()
}

fn load_generation(connection: &Connection) -> Result<u64, ConnectorAuthorityError> {
    let generation = connection
        .query_row(
            "SELECT snapshot_generation FROM connector_authority_meta WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sql_error)?;
    from_i64(generation)
}

fn update_generation(
    transaction: &rusqlite::Transaction<'_>,
    generation: ConnectorSnapshotGeneration,
) -> Result<(), ConnectorAuthorityError> {
    transaction
        .execute(
            "UPDATE connector_authority_meta SET snapshot_generation = ?1 WHERE singleton = 1",
            [to_i64(generation.get())?],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn insert_event(
    transaction: &rusqlite::Transaction<'_>,
    event: &AuthorityEvent,
    snapshot_generation: ConnectorSnapshotGeneration,
) -> Result<(), ConnectorAuthorityError> {
    let (kind, connection_generation, account_id, display_name, credential, digest, reason) =
        match event {
            AuthorityEvent::Begin {
                generation,
                definition_digest,
                ..
            } => (
                "begin",
                *generation,
                None,
                None,
                None,
                Some(definition_digest.as_str()),
                None,
            ),
            AuthorityEvent::Complete {
                account,
                definition_digest,
                ..
            } => (
                "complete",
                account.connection_generation(),
                Some(account.account_id().as_str()),
                Some(account.display_name()),
                Some(account.credential_reference().as_str()),
                Some(definition_digest.as_str()),
                None,
            ),
            AuthorityEvent::Unavailable {
                generation, reason, ..
            } => (
                "unavailable",
                *generation,
                None,
                None,
                None,
                None,
                Some(reason.as_str()),
            ),
            AuthorityEvent::Disconnect { generation, .. } => {
                ("disconnect", *generation, None, None, None, None, None)
            }
        };
    transaction
        .execute(
            "INSERT INTO connector_events (
                snapshot_generation, connector_id, event_kind, connection_generation,
                account_id, account_display_name, credential_reference, definition_digest, reason
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                to_i64(snapshot_generation.get())?,
                event.connector_id().as_str(),
                kind,
                to_i64(connection_generation.get())?,
                account_id,
                display_name,
                credential,
                digest,
                reason,
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn load_latest_records(
    connection: &Connection,
) -> Result<BTreeMap<ConnectorId, PersistedRecord>, ConnectorAuthorityError> {
    let mut statement = connection
        .prepare(
            "SELECT snapshot_generation, connector_id, event_kind, connection_generation,
                    account_id, account_display_name, credential_reference, definition_digest,
                    reason
             FROM connector_events ORDER BY sequence",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(sql_error)?;
    let mut records = BTreeMap::new();
    for row in rows {
        let (snapshot, connector, kind, generation, account, display, credential, digest, reason) =
            row.map_err(sql_error)?;
        let connector_id = ConnectorId::new(connector).map_err(domain_error)?;
        let generation = ConnectorConnectionGeneration::new(from_i64(generation)?);
        let event = match kind.as_str() {
            "begin" => AuthorityEvent::Begin {
                connector_id: connector_id.clone(),
                generation,
                definition_digest: ConnectorDefinitionDigest::new(required(
                    digest,
                    "definition digest",
                )?)
                .map_err(domain_error)?,
            },
            "complete" => AuthorityEvent::Complete {
                connector_id: connector_id.clone(),
                account: ConnectorAccount::new(
                    ConnectorAccountId::new(required(account, "account ID")?)
                        .map_err(domain_error)?,
                    required(display, "account display name")?,
                    ConnectorCredentialRef::new(required(credential, "credential reference")?)
                        .map_err(domain_error)?,
                    generation,
                )
                .map_err(domain_error)?,
                definition_digest: ConnectorDefinitionDigest::new(required(
                    digest,
                    "definition digest",
                )?)
                .map_err(domain_error)?,
            },
            "unavailable" => AuthorityEvent::Unavailable {
                connector_id: connector_id.clone(),
                generation,
                reason: required(reason, "unavailable reason")?,
            },
            "disconnect" => AuthorityEvent::Disconnect {
                connector_id: connector_id.clone(),
                generation,
            },
            _ => return Err(persistence_error("unknown Connector event kind")),
        };
        records.insert(
            connector_id,
            PersistedRecord {
                snapshot_generation: from_i64(snapshot)?,
                event,
            },
        );
    }
    Ok(records)
}

fn load_receipts(
    connection: &Connection,
) -> Result<BTreeMap<String, CommandReceipt>, ConnectorAuthorityError> {
    let mut statement = connection
        .prepare(
            "SELECT command_id, expected_generation, connector_id, command_digest,
                    result_generation FROM connector_command_receipts",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(sql_error)?;
    let mut receipts = BTreeMap::new();
    for row in rows {
        let (command_id, expected, connector_id, command_digest, result) =
            row.map_err(sql_error)?;
        receipts.insert(
            command_id,
            CommandReceipt {
                expected_generation: ConnectorSnapshotGeneration::new(from_i64(expected)?),
                connector_id: ConnectorId::new(connector_id).map_err(domain_error)?,
                command_digest,
                result_generation: ConnectorSnapshotGeneration::new(from_i64(result)?),
            },
        );
    }
    Ok(receipts)
}

fn required(value: Option<String>, label: &str) -> Result<String, ConnectorAuthorityError> {
    value.ok_or_else(|| persistence_error(format!("Connector event is missing {label}")))
}

fn to_i64(value: u64) -> Result<i64, ConnectorAuthorityError> {
    i64::try_from(value).map_err(|_| persistence_error("Connector generation exceeds SQLite"))
}

fn from_i64(value: i64) -> Result<u64, ConnectorAuthorityError> {
    u64::try_from(value).map_err(|_| persistence_error("Connector generation is negative"))
}

fn sql_error(error: rusqlite::Error) -> ConnectorAuthorityError {
    persistence_error(format!("Connector authority database failure: {error}"))
}
