use super::connection::from_sql_integer;
use super::connection::sql_error;
use super::connection::to_sql_integer;
use super::git_turn_changes::SqliteTurnChangeStore;
use ash_protocol::ThreadId;
use git_turn_changes::CommitState;
use git_turn_changes::TurnChangeSet;
use git_turn_changes::TurnChangeStoreError;
use git_turn_changes::TurnCommitRecord;
use git_turn_changes::TurnCommitSource;
use git_turn_changes::TurnCommitState;
use git_turn_changes::TurnCommitStore;
use git_turn_changes::TurnPublication;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use sha2::Digest;
use sha2::Sha256;

pub(super) fn create_schema(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "CREATE TABLE turn_commits (
        commit_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, revision INTEGER NOT NULL,
        record_json TEXT NOT NULL);
        CREATE INDEX turn_commits_thread ON turn_commits(thread_id);",
        )
        .map_err(sql_error)?;
    let records = {
        let mut statement = transaction
            .prepare("SELECT record_json FROM turn_change_sets ORDER BY rowid")
            .map_err(sql_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?
    };
    for json in records {
        let value: serde_json::Value = serde_json::from_str(&json).map_err(sql_error)?;
        let mut record: TurnChangeSet = serde_json::from_value(value.clone()).map_err(sql_error)?;
        let legacy: CommitState = serde_json::from_value(
            value
                .get("commitState")
                .cloned()
                .ok_or("legacy capture has no commit state")?,
        )
        .map_err(sql_error)?;
        if legacy != CommitState::Idle {
            let commit_id = format!(
                "changeset-{:x}",
                Sha256::digest(record.change_set_id.as_str())
            );
            let after = record
                .after_tree
                .clone()
                .ok_or("legacy commit has no sealed tree")?;
            let publication = match &legacy {
                CommitState::Committed { object_id } => TurnPublication::Receipt {
                    object_id: object_id.clone(),
                },
                CommitState::Queued
                | CommitState::Committing
                | CommitState::Conflict { .. }
                | CommitState::Failed { .. } => TurnPublication::MigratedDelta {
                    before_tree: record.before_tree.clone(),
                    after_tree: after.clone(),
                },
                CommitState::Idle | CommitState::PartiallyCommitted { .. } => {
                    return Err("unexpected legacy commit state".into());
                }
            };
            let state = match legacy {
                CommitState::Queued => TurnCommitState::Queued,
                CommitState::Committing => TurnCommitState::Publishing,
                CommitState::Committed { object_id } => TurnCommitState::Committed { object_id },
                CommitState::Conflict { paths, .. } => TurnCommitState::Conflict {
                    paths,
                    message: "migrated publication conflict".into(),
                },
                CommitState::Failed { message } => TurnCommitState::Failed { message },
                CommitState::Idle | CommitState::PartiallyCommitted { .. } => {
                    return Err("unexpected legacy commit state".into());
                }
            };
            let message = record
                .draft_message
                .clone()
                .ok_or("legacy commit has no frozen message")?;
            let commit = TurnCommitRecord {
                commit_id,
                session_id: record.session_id.clone(),
                thread_id: record.thread_id.clone(),
                repository_id: record.repository_id.clone(),
                target_branch: record
                    .target_branch
                    .clone()
                    .ok_or("legacy commit has no target branch")?,
                sources: vec![TurnCommitSource {
                    change_set_id: record.change_set_id.clone(),
                    expected_revision: record.revision,
                    evidence_digest: record.evidence_digest().map_err(sql_error)?.to_string(),
                    before_tree: record.before_tree.clone(),
                    selected_tree: after,
                    paths: record.files.iter().map(|file| file.path.clone()).collect(),
                }],
                message,
                warnings: record.warnings.clone(),
                publication,
                state,
                revision: 1,
            };
            insert_commit(transaction, &commit).map_err(sql_error)?;
        }
        record.commit_state = CommitState::Idle;
        transaction
            .execute(
                "UPDATE turn_change_sets SET record_json = ?1 WHERE change_set_id = ?2",
                params![
                    serde_json::to_string(&record).map_err(sql_error)?,
                    record.change_set_id.as_str()
                ],
            )
            .map_err(sql_error)?;
    }
    Ok(())
}

pub(super) fn list_commits(
    connection: &Connection,
    thread_id: &ThreadId,
) -> Result<Vec<TurnCommitRecord>, TurnChangeStoreError> {
    let mut statement = connection.prepare("SELECT commit_id, revision, record_json FROM turn_commits WHERE thread_id = ?1 ORDER BY rowid").map_err(storage)?;
    statement
        .query_map([thread_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage)?
        .map(|row| {
            let (id, revision, json) = row.map_err(storage)?;
            decode_commit(&id, revision, &json)
        })
        .collect()
}

fn decode_commit(
    id: &str,
    revision: i64,
    json: &str,
) -> Result<TurnCommitRecord, TurnChangeStoreError> {
    let record: TurnCommitRecord = serde_json::from_str(json).map_err(storage)?;
    if record.commit_id != id || record.revision != from_sql_integer(revision).map_err(storage)? {
        return Err(storage("commit row identity disagrees with its record"));
    }
    Ok(record)
}

fn load_commit(
    connection: &Connection,
    id: &str,
) -> Result<TurnCommitRecord, TurnChangeStoreError> {
    let row = connection
        .query_row(
            "SELECT revision, record_json FROM turn_commits WHERE commit_id = ?1",
            [id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage)?
        .ok_or_else(|| TurnChangeStoreError::NotFound(id.into()))?;
    decode_commit(id, row.0, &row.1)
}

fn insert_commit(
    connection: &Connection,
    record: &TurnCommitRecord,
) -> Result<(), TurnChangeStoreError> {
    connection.execute("INSERT INTO turn_commits (commit_id, thread_id, revision, record_json) VALUES (?1, ?2, ?3, ?4)", params![record.commit_id, record.thread_id.as_str(), to_sql_integer(record.revision).map_err(storage)?, serde_json::to_string(record).map_err(storage)?]).map_err(storage)?;
    Ok(())
}

fn replayed(
    transaction: &Transaction<'_>,
    id: &str,
    fingerprint: &str,
) -> Result<bool, TurnChangeStoreError> {
    let previous = transaction
        .query_row(
            "SELECT fingerprint FROM turn_change_commands WHERE command_id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage)?;
    match previous {
        Some(previous) if previous == fingerprint => Ok(true),
        Some(_) => Err(TurnChangeStoreError::CommandConflict(id.into())),
        None => Ok(false),
    }
}

fn receipt(
    transaction: &Transaction<'_>,
    id: &str,
    fingerprint: &str,
    response: &str,
) -> Result<(), TurnChangeStoreError> {
    transaction.execute("INSERT INTO turn_change_commands (command_id, fingerprint, response_json) VALUES (?1, ?2, ?3)", params![id, fingerprint, response]).map_err(storage)?;
    Ok(())
}

fn install_commit(
    transaction: &Transaction<'_>,
    expected: u64,
    record: &TurnCommitRecord,
) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError> {
    let updated = transaction.execute("UPDATE turn_commits SET revision = ?1, record_json = ?2 WHERE commit_id = ?3 AND revision = ?4", params![to_sql_integer(record.revision).map_err(storage)?, serde_json::to_string(record).map_err(storage)?, record.commit_id, to_sql_integer(expected).map_err(storage)?]).map_err(storage)?;
    if updated != 1 {
        return Err(TurnChangeStoreError::RevisionConflict {
            expected,
            actual: load_commit(transaction, &record.commit_id)?.revision,
        });
    }
    let commits = list_commits(transaction, &record.thread_id)?;
    let mut updates = Vec::new();
    for source in &record.sources {
        let json = transaction
            .query_row(
                "SELECT record_json FROM turn_change_sets WHERE change_set_id = ?1",
                [source.change_set_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .map_err(storage)?;
        let mut capture: TurnChangeSet = serde_json::from_str(&json).map_err(storage)?;
        capture.revision = capture
            .revision
            .checked_add(1)
            .ok_or_else(|| storage("Turn revision overflow"))?;
        transaction.execute("UPDATE turn_change_sets SET revision = ?1, record_json = ?2 WHERE change_set_id = ?3", params![to_sql_integer(capture.revision).map_err(storage)?, serde_json::to_string(&capture).map_err(storage)?, capture.change_set_id.as_str()]).map_err(storage)?;
        git_turn_changes::derive_commit_progress(&mut capture, &commits);
        updates.push(capture);
    }
    Ok(updates)
}

impl TurnCommitStore for SqliteTurnChangeStore {
    fn list_commits(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<TurnCommitRecord>, TurnChangeStoreError> {
        list_commits(&*self.connection()?, thread_id)
    }
    fn load_commit(&self, commit_id: &str) -> Result<TurnCommitRecord, TurnChangeStoreError> {
        load_commit(&*self.connection()?, commit_id)
    }
    fn save_preview(
        &self,
        record: &TurnCommitRecord,
        command_id: &str,
        fingerprint: &str,
        response: &str,
    ) -> Result<(), TurnChangeStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if replayed(&transaction, command_id, fingerprint)? {
            return Ok(());
        }
        if record.state != TurnCommitState::Preview || record.revision != 1 {
            return Err(storage("new commit must be a preview"));
        }
        insert_commit(&transaction, record)?;
        receipt(&transaction, command_id, fingerprint, response)?;
        transaction.commit().map_err(storage)
    }
    fn queue_publication(
        &self,
        commit_id: &str,
        command_id: &str,
        fingerprint: &str,
        response: &str,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if replayed(&transaction, command_id, fingerprint)? {
            return Ok(Vec::new());
        }
        let record = load_commit(&transaction, commit_id)?;
        let captures = record
            .sources
            .iter()
            .map(|source| {
                let json = transaction
                    .query_row(
                        "SELECT record_json FROM turn_change_sets WHERE change_set_id = ?1",
                        [source.change_set_id.as_str()],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(storage)?;
                serde_json::from_str::<TurnChangeSet>(&json).map_err(storage)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let expected = record.revision;
        let record = git_turn_changes::queued_publication(
            &record,
            &captures,
            &list_commits(&transaction, &record.thread_id)?,
        )?;
        let updates = install_commit(&transaction, expected, &record)?;
        receipt(&transaction, command_id, fingerprint, response)?;
        transaction.commit().map_err(storage)?;
        Ok(updates)
    }
    fn update_publication(
        &self,
        expected_revision: u64,
        record: &TurnCommitRecord,
    ) -> Result<Vec<TurnChangeSet>, TurnChangeStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let current = load_commit(&transaction, &record.commit_id)?;
        git_turn_changes::validate_publication_update(&current, expected_revision, record)?;
        let updates = install_commit(&transaction, expected_revision, record)?;
        transaction.commit().map_err(storage)?;
        Ok(updates)
    }
}

fn storage(error: impl std::fmt::Display) -> TurnChangeStoreError {
    TurnChangeStoreError::Storage(sql_error(error))
}
