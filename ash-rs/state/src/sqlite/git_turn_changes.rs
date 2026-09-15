use super::connection::{from_sql_integer, open, sql_error, to_sql_integer};
use ash_protocol::ThreadId;
use git_turn_changes::{ChangeSetId, TurnChangeSet, TurnChangeStore, TurnChangeStoreError};
use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior, params};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TurnChangeCommandOutcome {
    Applied,
    Replayed(String),
}

/// SQLite implementation of the durable Turn change-set store.
pub struct SqliteTurnChangeStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SqliteTurnChangeStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, TurnChangeStoreError> {
        let path = path.into();
        let connection = open(&path).map_err(TurnChangeStoreError::Storage)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn replay_command(
        &self,
        command_id: &str,
        fingerprint: &str,
    ) -> Result<Option<String>, TurnChangeStoreError> {
        let connection = self.connection()?;
        let receipt = connection
            .query_row(
                "SELECT fingerprint, response_json FROM turn_change_commands
                 WHERE command_id = ?1",
                [command_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        match receipt {
            Some((stored_fingerprint, response)) if stored_fingerprint == fingerprint => {
                Ok(Some(response))
            }
            Some(_) => Err(TurnChangeStoreError::CommandConflict(command_id.into())),
            None => Ok(None),
        }
    }

    /// Atomically installs complete change-set records and records the exact RPC response.
    /// A retry with the same command ID and fingerprint receives the original response even if
    /// background work has advanced the records in the meantime.
    pub fn apply_command(
        &self,
        command_id: &str,
        fingerprint: &str,
        expected_thread_revision: Option<(&ThreadId, u64)>,
        change_sets: &[TurnChangeSet],
        response_json: &str,
    ) -> Result<TurnChangeCommandOutcome, TurnChangeStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if let Some((stored_fingerprint, stored_response)) = transaction
            .query_row(
                "SELECT fingerprint, response_json FROM turn_change_commands
                 WHERE command_id = ?1",
                [command_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
        {
            if stored_fingerprint != fingerprint {
                return Err(TurnChangeStoreError::CommandConflict(command_id.into()));
            }
            transaction.commit().map_err(storage_error)?;
            return Ok(TurnChangeCommandOutcome::Replayed(stored_response));
        }

        if let Some((thread_id, expected)) = expected_thread_revision {
            let actual = transaction
                .query_row(
                    "SELECT COALESCE(MAX(revision), 0) FROM turn_change_sets WHERE thread_id = ?1",
                    [thread_id.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(storage_error)?;
            let actual = from_sql_integer(actual).map_err(TurnChangeStoreError::Storage)?;
            if actual != expected {
                return Err(TurnChangeStoreError::RevisionConflict { expected, actual });
            }
        }

        for change_set in change_sets {
            let expected = change_set.revision.checked_sub(1).ok_or_else(|| {
                TurnChangeStoreError::Storage(
                    "command change-set record does not contain a next revision".into(),
                )
            })?;
            let updated = transaction
                .execute(
                    "UPDATE turn_change_sets SET thread_id = ?1, revision = ?2, record_json = ?3
                     WHERE change_set_id = ?4 AND revision = ?5",
                    params![
                        change_set.thread_id.as_str(),
                        to_sql_integer(change_set.revision)
                            .map_err(TurnChangeStoreError::Storage)?,
                        serialize(change_set)?,
                        change_set.change_set_id.as_str(),
                        to_sql_integer(expected).map_err(TurnChangeStoreError::Storage)?,
                    ],
                )
                .map_err(storage_error)?;
            if updated != 1 {
                let actual = transaction
                    .query_row(
                        "SELECT revision FROM turn_change_sets WHERE change_set_id = ?1",
                        [change_set.change_set_id.as_str()],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(storage_error)?
                    .ok_or_else(|| {
                        TurnChangeStoreError::NotFound(change_set.change_set_id.to_string())
                    })?;
                return Err(TurnChangeStoreError::RevisionConflict {
                    expected,
                    actual: from_sql_integer(actual).map_err(TurnChangeStoreError::Storage)?,
                });
            }
        }
        transaction
            .execute(
                "INSERT INTO turn_change_commands (command_id, fingerprint, response_json)
                 VALUES (?1, ?2, ?3)",
                params![command_id, fingerprint, response_json],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(TurnChangeCommandOutcome::Applied)
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, TurnChangeStoreError> {
        self.connection
            .lock()
            .map_err(|_| TurnChangeStoreError::Storage("Turn changes SQLite lock poisoned".into()))
    }
}

impl TurnChangeStore for SqliteTurnChangeStore {
    fn insert(&self, change_set: &TurnChangeSet) -> Result<(), TurnChangeStoreError> {
        let connection = self.connection()?;
        let record = serialize(change_set)?;
        connection
            .execute(
                "INSERT INTO turn_change_sets
                 (change_set_id, thread_id, revision, record_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    change_set.change_set_id.as_str(),
                    change_set.thread_id.as_str(),
                    to_sql_integer(change_set.revision).map_err(TurnChangeStoreError::Storage)?,
                    record,
                ],
            )
            .map_err(|error| match &error {
                rusqlite::Error::SqliteFailure(failure, _)
                    if failure.code == ErrorCode::ConstraintViolation =>
                {
                    TurnChangeStoreError::AlreadyExists(change_set.change_set_id.to_string())
                }
                _ => storage_error(error),
            })?;
        Ok(())
    }

    fn load(&self, change_set_id: &ChangeSetId) -> Result<TurnChangeSet, TurnChangeStoreError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT revision, record_json FROM turn_change_sets WHERE change_set_id = ?1",
                [change_set_id.as_str()],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| TurnChangeStoreError::NotFound(change_set_id.to_string()))?;
        deserialize_checked(change_set_id, row.0, &row.1)
    }

    fn list_for_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT change_set_id, revision, record_json FROM turn_change_sets
                 WHERE thread_id = ?1 ORDER BY rowid",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([thread_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage_error)?;
        let mut change_sets = Vec::new();
        for row in rows {
            let (change_set_id, revision, record) = row.map_err(storage_error)?;
            let change_set_id = ChangeSetId::new(change_set_id)
                .map_err(|error| TurnChangeStoreError::Storage(error.to_string()))?;
            let change_set = deserialize_checked(&change_set_id, revision, &record)?;
            if &change_set.thread_id != thread_id {
                return Err(TurnChangeStoreError::Storage(
                    "Turn change-set row thread disagrees with its record".into(),
                ));
            }
            change_sets.push(change_set);
        }
        Ok(change_sets)
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        change_set: &TurnChangeSet,
    ) -> Result<(), TurnChangeStoreError> {
        let next_revision = expected_revision.checked_add(1).ok_or_else(|| {
            TurnChangeStoreError::Storage("Turn change-set revision overflowed".into())
        })?;
        if change_set.revision != next_revision {
            return Err(TurnChangeStoreError::Storage(
                "Turn change-set record does not contain the next revision".into(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let record = serialize(change_set)?;
        let updated = transaction
            .execute(
                "UPDATE turn_change_sets SET thread_id = ?1, revision = ?2, record_json = ?3
                 WHERE change_set_id = ?4 AND revision = ?5",
                params![
                    change_set.thread_id.as_str(),
                    to_sql_integer(change_set.revision).map_err(TurnChangeStoreError::Storage)?,
                    record,
                    change_set.change_set_id.as_str(),
                    to_sql_integer(expected_revision).map_err(TurnChangeStoreError::Storage)?,
                ],
            )
            .map_err(storage_error)?;
        if updated != 1 {
            let actual = transaction
                .query_row(
                    "SELECT revision FROM turn_change_sets WHERE change_set_id = ?1",
                    [change_set.change_set_id.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(storage_error)?
                .ok_or_else(|| {
                    TurnChangeStoreError::NotFound(change_set.change_set_id.to_string())
                })?;
            return Err(TurnChangeStoreError::RevisionConflict {
                expected: expected_revision,
                actual: from_sql_integer(actual).map_err(TurnChangeStoreError::Storage)?,
            });
        }
        transaction.commit().map_err(storage_error)?;
        Ok(())
    }
}

fn serialize(change_set: &TurnChangeSet) -> Result<String, TurnChangeStoreError> {
    serde_json::to_string(change_set)
        .map_err(|error| TurnChangeStoreError::Storage(error.to_string()))
}

fn deserialize_checked(
    change_set_id: &ChangeSetId,
    revision: i64,
    record: &str,
) -> Result<TurnChangeSet, TurnChangeStoreError> {
    let change_set = serde_json::from_str::<TurnChangeSet>(record)
        .map_err(|error| TurnChangeStoreError::Storage(error.to_string()))?;
    let revision = from_sql_integer(revision).map_err(TurnChangeStoreError::Storage)?;
    if &change_set.change_set_id != change_set_id || change_set.revision != revision {
        return Err(TurnChangeStoreError::Storage(
            "Turn change-set row metadata disagrees with its record".into(),
        ));
    }
    Ok(change_set)
}

fn storage_error(error: impl std::fmt::Display) -> TurnChangeStoreError {
    TurnChangeStoreError::Storage(sql_error(error))
}
