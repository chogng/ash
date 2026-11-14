use ash_protocol::ContentDigest;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::Turn;
use ash_sqlite::Migration;
use ash_sqlite::Migrator;
use ash_thread_store::ThreadStoreError;
use rusqlite::Connection;
use rusqlite::params;

const MIGRATOR: Migrator<'_> = Migrator::new(
    "thread-completions",
    &[Migration::sql(
        1,
        include_str!("../../migrations/thread-completions/0001_pending_completions.sql"),
    )],
);

/// An immutable delivery snapshot, retained until the application acknowledges its work.
/// It survives history rewrites and deletion without becoming another readable Thread model.
#[derive(Debug)]
pub struct ThreadCompletion {
    pub id: i64,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn: Turn,
}

pub(super) fn migrate(connection: &mut Connection) -> Result<(), ThreadStoreError> {
    MIGRATOR.run(connection).map_err(ThreadStoreError::Storage)
}

pub(super) fn stage(
    connection: &Connection,
    session_id: &SessionId,
    thread_id: &ThreadId,
    sequence: u64,
    turn: &Turn,
) -> Result<(), ThreadStoreError> {
    let json = serde_json::to_string(turn).map_err(error)?;
    let digest = ContentDigest::sha256(json.as_bytes());
    connection
        .execute(
            "INSERT OR IGNORE INTO pending_thread_completions
         (thread_id, sequence, session_id, turn_json, turn_digest) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                thread_id.as_str(),
                super::connection::to_sql_integer(sequence).map_err(error)?,
                session_id.as_str(),
                json,
                digest.as_str()
            ],
        )
        .map_err(error)?;
    Ok(())
}

pub(super) fn pending(
    connection: &Connection,
    after_id: i64,
) -> Result<Vec<ThreadCompletion>, ThreadStoreError> {
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, thread_id, turn_json, turn_digest
         FROM pending_thread_completions WHERE id > ?1 ORDER BY id LIMIT 64",
        )
        .map_err(error)?;
    let rows = statement
        .query_map([after_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(error)?;
    rows.map(|row| {
        let (id, session, thread, json, digest) = row.map_err(error)?;
        if ContentDigest::sha256(json.as_bytes()).as_str() != digest {
            return Err(error("Thread completion snapshot digest mismatch"));
        }
        Ok(ThreadCompletion {
            id,
            session_id: SessionId::new(session).map_err(error)?,
            thread_id: ThreadId::new(thread).map_err(error)?,
            turn: serde_json::from_str(&json).map_err(error)?,
        })
    })
    .collect()
}

pub(super) fn acknowledge(connection: &Connection, id: i64) -> Result<(), ThreadStoreError> {
    connection
        .execute("DELETE FROM pending_thread_completions WHERE id = ?1", [id])
        .map_err(error)?;
    Ok(())
}

fn error(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "thread_completions_tests.rs"]
mod tests;
