use std::sync::Mutex;

use ash_state::{SqliteDurability, open_in_memory_database, open_sqlite_database};
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;

use crate::CloudCodebaseDestination;
use crate::CloudCodebaseError;
use crate::CloudCodebaseGrant;
use crate::CloudCodebaseGrantId;
use crate::CloudCodebaseId;
use crate::CloudCodebaseSelection;
use crate::CloudCodebaseState;
use crate::CloudCodebaseStorage;

const BASELINE_VERSION: u32 = 3;
type Migration = fn(&Transaction<'_>, Option<u32>) -> Result<(), CloudCodebaseError>;
const MIGRATIONS: &[Migration] = &[adopt_v3];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurableCloudState {
    pub phase: CloudCodebaseState,
    pub grant: Option<CloudCodebaseGrant>,
    pub synced_local_generation: Option<u64>,
    pub remote_generation: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
enum LegacyCloudCodebaseMode {
    Projection,
    Managed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct LegacyCloudCodebaseGrant {
    id: CloudCodebaseGrantId,
    root_id: String,
    mode: LegacyCloudCodebaseMode,
    destination: CloudCodebaseDestination,
    selection: CloudCodebaseSelection,
    max_egress_bytes: std::num::NonZeroU64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct LegacyDurableCloudState {
    phase: CloudCodebaseState,
    grant: Option<LegacyCloudCodebaseGrant>,
    synced_local_generation: Option<u64>,
    remote_generation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct LegacyGrantWithoutCloudId {
    id: CloudCodebaseGrantId,
    root_id: String,
    destination: CloudCodebaseDestination,
    selection: CloudCodebaseSelection,
    max_egress_bytes: std::num::NonZeroU64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct LegacyStateWithoutCloudId {
    phase: CloudCodebaseState,
    grant: Option<LegacyGrantWithoutCloudId>,
    synced_local_generation: Option<u64>,
    remote_generation: Option<String>,
}

impl Default for DurableCloudState {
    fn default() -> Self {
        Self {
            phase: CloudCodebaseState::LocalOnly,
            grant: None,
            synced_local_generation: None,
            remote_generation: None,
        }
    }
}

pub(crate) struct CloudStateStore {
    connection: Mutex<Connection>,
}

impl CloudStateStore {
    pub fn open(storage: &CloudCodebaseStorage, root_id: &str) -> Result<Self, CloudCodebaseError> {
        let mut connection = match storage {
            CloudCodebaseStorage::Memory => open_in_memory_database(SqliteDurability::Durable)
                .map_err(CloudCodebaseError::DatabaseRuntime)?,
            CloudCodebaseStorage::Persistent(path) => {
                open_sqlite_database(path, SqliteDurability::Durable)
                    .map_err(CloudCodebaseError::DatabaseRuntime)?
            }
        };
        initialize(&mut connection, root_id)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn load(&self) -> Result<DurableCloudState, CloudCodebaseError> {
        let connection = self.connection.lock().expect("cloud index store poisoned");
        let state =
            metadata(&connection, "state")?.ok_or(CloudCodebaseError::IncompatibleStorage)?;
        Ok(serde_json::from_str(&state)?)
    }

    pub fn save(&self, state: &DurableCloudState) -> Result<(), CloudCodebaseError> {
        let connection = self.connection.lock().expect("cloud index store poisoned");
        set_metadata(&connection, "state", &serde_json::to_string(state)?)?;
        Ok(())
    }
}

fn initialize(connection: &mut Connection, root_id: &str) -> Result<(), CloudCodebaseError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(include_str!("../migrations/0003_metadata.sql"))?;
    match metadata(&transaction, "root_id")? {
        Some(stored) if stored != root_id => return Err(CloudCodebaseError::StorageRootMismatch),
        Some(_) => {}
        None => set_metadata(&transaction, "root_id", root_id)?,
    }
    let latest = BASELINE_VERSION + MIGRATIONS.len() as u32 - 1;
    let version = metadata(&transaction, "schema_version")?
        .map(|stored| {
            stored
                .parse::<u32>()
                .ok()
                .filter(|version| (1..=latest).contains(version) && version.to_string() == stored)
                .ok_or(CloudCodebaseError::IncompatibleStorage)
        })
        .transpose()?;
    for (target, migration) in (BASELINE_VERSION..)
        .zip(MIGRATIONS)
        .filter(|(target, _)| version.is_none_or(|version| *target > version))
    {
        migration(&transaction, version)?;
        set_metadata(&transaction, "schema_version", &target.to_string())?;
    }
    if metadata(&transaction, "state")?.is_none() {
        set_metadata(
            &transaction,
            "state",
            &serde_json::to_string(&DurableCloudState::default())?,
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn adopt_v3(transaction: &Transaction<'_>, version: Option<u32>) -> Result<(), CloudCodebaseError> {
    let Some(version) = version else {
        return Ok(());
    };
    let state = metadata(transaction, "state")?.ok_or(CloudCodebaseError::IncompatibleStorage)?;
    let current = if version == 1 {
        let legacy = serde_json::from_str::<LegacyDurableCloudState>(&state)?;
        let managed_grant = legacy
            .grant
            .as_ref()
            .is_some_and(|grant| grant.mode == LegacyCloudCodebaseMode::Managed);
        DurableCloudState {
            phase: if managed_grant {
                CloudCodebaseState::Revoking
            } else {
                legacy.phase
            },
            grant: legacy
                .grant
                .map(|grant| -> Result<_, CloudCodebaseError> {
                    let codebase_id = CloudCodebaseId::new(grant.destination.collection.clone())?;
                    Ok(CloudCodebaseGrant {
                        id: grant.id,
                        codebase_id,
                        root_id: grant.root_id,
                        destination: grant.destination,
                        selection: grant.selection,
                        max_egress_bytes: grant.max_egress_bytes,
                    })
                })
                .transpose()?,
            synced_local_generation: legacy.synced_local_generation,
            remote_generation: legacy.remote_generation,
        }
    } else {
        let legacy = serde_json::from_str::<LegacyStateWithoutCloudId>(&state)?;
        DurableCloudState {
            phase: legacy.phase,
            grant: legacy
                .grant
                .map(|grant| -> Result<_, CloudCodebaseError> {
                    let codebase_id = CloudCodebaseId::new(grant.destination.collection.clone())?;
                    Ok(CloudCodebaseGrant {
                        id: grant.id,
                        codebase_id,
                        root_id: grant.root_id,
                        destination: grant.destination,
                        selection: grant.selection,
                        max_egress_bytes: grant.max_egress_bytes,
                    })
                })
                .transpose()?,
            synced_local_generation: legacy.synced_local_generation,
            remote_generation: legacy.remote_generation,
        }
    };
    set_metadata(transaction, "state", &serde_json::to_string(&current)?)?;
    Ok(())
}

fn metadata(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM cloud_codebase_metadata WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
}

fn set_metadata(connection: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO cloud_codebase_metadata(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
