use crate::SqliteDurability;
use crate::open_sqlite_database;
use guardian_environment::EnvironmentError;
use guardian_environment::EnvironmentProfile;
use guardian_environment::EnvironmentStore;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::path::Path;
use std::sync::Mutex;

pub struct SqliteEnvironmentStore {
    connection: Mutex<Connection>,
}

impl SqliteEnvironmentStore {
    pub fn open(path: &Path) -> Result<Self, EnvironmentError> {
        let mut connection = open_sqlite_database(path, SqliteDurability::Durable)
            .map_err(EnvironmentError::Storage)?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS ash_schema_migrations (component TEXT PRIMARY KEY, version INTEGER NOT NULL)").map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let version = transaction
            .query_row(
                "SELECT version FROM ash_schema_migrations WHERE component='approval_environment'",
                [],
                |row| row.get::<_, u32>(0),
            )
            .optional()
            .map_err(storage_error)?;
        match version {
            None => {
                transaction.execute_batch("CREATE TABLE approval_environments (project TEXT PRIMARY KEY, revision INTEGER NOT NULL, profile TEXT NOT NULL); CREATE TABLE approval_environment_commands (project TEXT NOT NULL, command_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(project, command_id)); INSERT INTO ash_schema_migrations(component,version) VALUES('approval_environment',1);").map_err(storage_error)?;
            }
            Some(1) => {}
            Some(version) => {
                return Err(EnvironmentError::Storage(format!(
                    "unsupported approval environment schema version {version}"
                )));
            }
        }
        transaction.commit().map_err(storage_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

impl EnvironmentStore for SqliteEnvironmentStore {
    fn read(&self, project: &str) -> Result<EnvironmentProfile, EnvironmentError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EnvironmentError::Storage("environment lock poisoned".into()))?;
        load(&connection, project)
    }

    fn save(
        &self,
        project: &str,
        command_id: &str,
        request_digest: &str,
        expected_revision: u64,
        profile: &EnvironmentProfile,
    ) -> Result<EnvironmentProfile, EnvironmentError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| EnvironmentError::Storage("environment lock poisoned".into()))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if let Some(receipt) = receipt(&transaction, project, command_id, request_digest)? {
            return Ok(receipt);
        }
        if load(&transaction, project)?.revision != expected_revision {
            return Err(EnvironmentError::Conflict);
        }
        let mut saved = profile.clone();
        saved.revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| EnvironmentError::Storage("revision exhausted".into()))?;
        let response = serde_json::to_string(&saved)
            .map_err(|error| EnvironmentError::Storage(error.to_string()))?;
        transaction.execute("INSERT INTO approval_environments(project,revision,profile) VALUES(?1,?2,?3) ON CONFLICT(project) DO UPDATE SET revision=excluded.revision,profile=excluded.profile", params![project, i64::try_from(saved.revision).map_err(|error| EnvironmentError::Storage(error.to_string()))?, response]).map_err(storage_error)?;
        transaction.execute("INSERT INTO approval_environment_commands(project,command_id,request,response) VALUES(?1,?2,?3,?4)", params![project, command_id, request_digest, response]).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(saved)
    }

    fn receipt(
        &self,
        project: &str,
        command_id: &str,
        request_digest: &str,
    ) -> Result<Option<EnvironmentProfile>, EnvironmentError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| EnvironmentError::Storage("environment lock poisoned".into()))?;
        receipt(&connection, project, command_id, request_digest)
    }
}

fn receipt(
    connection: &Connection,
    project: &str,
    command_id: &str,
    request_digest: &str,
) -> Result<Option<EnvironmentProfile>, EnvironmentError> {
    let receipt: Option<(String, String)> = connection.query_row("SELECT request,response FROM approval_environment_commands WHERE project=?1 AND command_id=?2", params![project, command_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(storage_error)?;
    receipt
        .map(|(original, response)| {
            if original != request_digest {
                return Err(EnvironmentError::Conflict);
            }
            serde_json::from_str(&response)
                .map_err(|error| EnvironmentError::Storage(error.to_string()))
        })
        .transpose()
}

fn load(connection: &Connection, project: &str) -> Result<EnvironmentProfile, EnvironmentError> {
    let json: Option<String> = connection
        .query_row(
            "SELECT profile FROM approval_environments WHERE project=?1",
            [project],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    json.map(|json| {
        serde_json::from_str(&json).map_err(|error| EnvironmentError::Storage(error.to_string()))
    })
    .transpose()
    .map(Option::unwrap_or_default)
}

fn storage_error(error: rusqlite::Error) -> EnvironmentError {
    EnvironmentError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "approval_environment_tests.rs"]
mod tests;
