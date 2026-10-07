use async_utils::CancellationToken;
use protocol::SessionId;
use protocol::ThreadId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

const MAX_NOTE_BYTES: usize = 1_000_000;
const MAX_THREAD_BYTES: i64 = 8_000_000;

#[derive(Serialize)]
pub struct Note {
    pub path: String,
    pub revision: i64,
    pub body: String,
}

/// Durable task notes isolated by Session and Thread, with optimistic write concurrency.
pub struct NotesStore {
    database: Mutex<Connection>,
}
impl NotesStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = state::open_sqlite_database(path, state::SqliteDurability::Durable)
            .map_err(|e| e.to_string())?;
        Self::from_database(db)
    }
    pub fn in_memory() -> Result<Self, String> {
        Self::from_database(
            state::open_in_memory_database(state::SqliteDurability::Durable)
                .map_err(|e| e.to_string())?,
        )
    }
    fn from_database(database: Connection) -> Result<Self, String> {
        database.execute_batch("CREATE TABLE IF NOT EXISTS task_notes (session TEXT NOT NULL, thread TEXT NOT NULL, path TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session, thread, path));").map_err(|e| e.to_string())?;
        Ok(Self {
            database: Mutex::new(database),
        })
    }
    pub fn list(&self, session: &SessionId, thread: &ThreadId) -> Result<Vec<Note>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "notes database lock poisoned")?;
        let mut statement = database.prepare("SELECT path, revision, body FROM task_notes WHERE session=?1 AND thread=?2 ORDER BY path").map_err(|e| e.to_string())?;
        statement
            .query_map(params![session.as_str(), thread.as_str()], |row| {
                Ok(Note {
                    path: row.get(0)?,
                    revision: row.get(1)?,
                    body: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn write(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        path: &str,
        body: &str,
        expected_revision: i64,
        cancellation: &CancellationToken,
    ) -> Result<Note, String> {
        validate_path(path)?;
        if expected_revision < 0 {
            return Err("note revision must be non-negative".into());
        }
        if body.len() > MAX_NOTE_BYTES {
            return Err("note exceeds 1 MB".into());
        }
        let mut db = self
            .database
            .lock()
            .map_err(|_| "notes database lock poisoned")?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let revision: Option<i64> = tx
            .query_row(
                "SELECT revision FROM task_notes WHERE session=?1 AND thread=?2 AND path=?3",
                params![session.as_str(), thread.as_str(), path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if revision.unwrap_or(0) != expected_revision {
            return Err("note revision conflict; read the current note before writing".into());
        }
        let revision = expected_revision
            .checked_add(1)
            .filter(|revision| *revision > 0)
            .ok_or("note revision overflow")?;
        let (count, bytes): (i64,i64) = tx.query_row("SELECT COUNT(*), COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM task_notes WHERE session=?1 AND thread=?2 AND path != ?3",params![session.as_str(),thread.as_str(),path],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|e|e.to_string())?;
        if count >= 128 || bytes + body.len() as i64 > MAX_THREAD_BYTES {
            return Err("task notes capacity exceeded".into());
        }
        cancellation.check().map_err(|e| e.reason().to_string())?;
        tx.execute("INSERT INTO task_notes VALUES (?1,?2,?3,?4,?5) ON CONFLICT(session,thread,path) DO UPDATE SET revision=excluded.revision,body=excluded.body", params![session.as_str(),thread.as_str(),path,revision,body]).map_err(|e|e.to_string())?;
        cancellation.check().map_err(|e| e.reason().to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Note {
            path: path.into(),
            revision,
            body: body.into(),
        })
    }
    pub fn delete_session(&self, session: &SessionId) -> Result<(), String> {
        self.database
            .lock()
            .map_err(|_| "notes database lock poisoned")?
            .execute(
                "DELETE FROM task_notes WHERE session=?1",
                params![session.as_str()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
fn validate_path(path: &str) -> Result<(), String> {
    if path.len() > 256
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err("note path must be a bounded relative virtual path".into());
    }
    Ok(())
}
