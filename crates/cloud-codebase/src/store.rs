use std::sync::Mutex;

use ash_state::{SqliteDurability, open_in_memory_database, open_sqlite_database};
use rusqlite::Connection;
use rusqlite::OptionalExtension;
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

const SCHEMA_VERSION: &str = "3";
const LEGACY_MODE_SCHEMA_VERSION: &str = "1";
const LEGACY_GRANT_SCHEMA_VERSION: &str = "2";

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
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS cloud_codebase_metadata (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )?;
        let stored_root = metadata(&connection, "root_id")?;
        if stored_root
            .as_deref()
            .is_some_and(|stored| stored != root_id)
        {
            return Err(CloudCodebaseError::StorageRootMismatch);
        }
        let stored_schema = metadata(&connection, "schema_version")?;
        match stored_schema.as_deref() {
            None | Some(SCHEMA_VERSION) => {}
            Some(LEGACY_MODE_SCHEMA_VERSION) | Some(LEGACY_GRANT_SCHEMA_VERSION) => {
                migrate_cloud_state(&mut connection, stored_schema.as_deref().unwrap())?;
            }
            Some(_) => return Err(CloudCodebaseError::IncompatibleStorage),
        }
        set_metadata(&connection, "root_id", root_id)?;
        set_metadata(&connection, "schema_version", SCHEMA_VERSION)?;
        if metadata(&connection, "state")?.is_none() {
            set_metadata(
                &connection,
                "state",
                &serde_json::to_string(&DurableCloudState::default())?,
            )?;
        }
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

fn migrate_cloud_state(
    connection: &mut Connection,
    schema_version: &str,
) -> Result<(), CloudCodebaseError> {
    let state = metadata(connection, "state")?.ok_or(CloudCodebaseError::IncompatibleStorage)?;
    let current = if schema_version == LEGACY_MODE_SCHEMA_VERSION {
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
    let transaction = connection.transaction()?;
    set_metadata(&transaction, "state", &serde_json::to_string(&current)?)?;
    set_metadata(&transaction, "schema_version", SCHEMA_VERSION)?;
    transaction.commit()?;
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
