use crate::SqliteDurability;
use crate::open_sqlite_database;
use message_history::MAX_PAGE_BYTES;
use message_history::MessageHistoryEntry as Entry;
use message_history::MessageHistoryKind as InputKind;
use message_history::MessageHistoryPage as Page;
use message_history::MessageHistoryQuery as Query;
use message_history::MessageHistoryRetention as Retention;
use message_history::MessageHistoryStore;
use message_history::MessageHistorySubmission as Submission;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Profile-local user input storage, with no dependency on Thread lifecycle or event replay.
pub struct SqliteMessageHistory {
    connection: Mutex<Connection>,
    retention: Retention,
}

impl SqliteMessageHistory {
    pub fn open(path: &Path, retention: Retention) -> Result<Self, String> {
        retention.validate()?;
        let mut connection = open_sqlite_database(path, SqliteDurability::Durable)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                 component TEXT PRIMARY KEY, version INTEGER NOT NULL
             );",
            )
            .map_err(sql_error)?;
        let version: Option<u32> = transaction
            .query_row(
                "SELECT version FROM ash_schema_migrations WHERE component = 'message-history'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        match version {
            None => {
                transaction
                    .execute_batch(
                        "CREATE TABLE message_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        submitted_at_ms INTEGER NOT NULL,
                        kind TEXT NOT NULL CHECK(kind IN ('agent', 'shell', 'command')),
                        thread_id TEXT,
                        text TEXT NOT NULL,
                        search_text TEXT NOT NULL,
                        text_bytes INTEGER NOT NULL CHECK(text_bytes > 0)
                    );
                    CREATE INDEX message_history_kind ON message_history(kind, id);
                    INSERT INTO ash_schema_migrations(component, version)
                    VALUES ('message-history', 1);",
                    )
                    .map_err(sql_error)?;
            }
            Some(1) => {}
            Some(version) => {
                return Err(format!(
                    "Unsupported input history schema version {version}"
                ));
            }
        }
        prune(&transaction, retention)?;
        transaction.commit().map_err(sql_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            retention,
        })
    }
}

impl MessageHistoryStore for SqliteMessageHistory {
    fn append(&self, submission: Submission) -> Result<Entry, String> {
        submission.validate()?;
        let submitted_at_ms = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis(),
        )
        .map_err(|_| "Input history timestamp is out of range")?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "Input history lock poisoned")?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        transaction.execute(
            "INSERT INTO message_history(submitted_at_ms, kind, thread_id, text, search_text, text_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (i64::try_from(submitted_at_ms).map_err(|_| "Input history timestamp is out of range")?, kind_name(submission.kind), &submission.thread_id,
             &submission.text, submission.text.to_lowercase(), submission.text.len() as i64),
        ).map_err(sql_error)?;
        let id = u64::try_from(transaction.last_insert_rowid())
            .map_err(|_| "Invalid input history identity")?;
        prune(&transaction, self.retention)?;
        transaction.commit().map_err(sql_error)?;
        Ok(Entry {
            id,
            submitted_at_ms,
            submission,
        })
    }

    fn read(&self, query: &Query) -> Result<Page, String> {
        query.validate()?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Input history lock poisoned")?;
        let mut statement = connection
            .prepare(
                "SELECT id, submitted_at_ms, kind, thread_id, text FROM message_history
             WHERE (?1 IS NULL OR id < ?1)
               AND (?2 IS NULL OR kind = ?2)
               AND instr(search_text, ?3) > 0
             ORDER BY id DESC LIMIT ?4",
            )
            .map_err(sql_error)?;
        let mut rows = statement
            .query((
                query.before.map(|id| id as i64),
                query.kind.map(kind_name),
                query.text.to_lowercase(),
                query.limit + 1,
            ))
            .map_err(sql_error)?;
        let mut page = Page::default();
        let mut bytes = 0;
        while let Some(row) = rows.next().map_err(sql_error)? {
            let text: String = row.get(4).map_err(sql_error)?;
            if !page.entries.is_empty()
                && (page.entries.len() == query.limit as usize
                    || bytes + text.len() > MAX_PAGE_BYTES)
            {
                page.next_before = page.entries.last().map(|entry| entry.id);
                break;
            }
            let kind: String = row.get(2).map_err(sql_error)?;
            let kind = match kind.as_str() {
                "agent" => InputKind::Agent,
                "shell" => InputKind::Shell,
                "command" => InputKind::Command,
                _ => return Err("Invalid stored input history kind".into()),
            };
            bytes += text.len();
            let submission = Submission {
                text,
                kind,
                thread_id: row.get(3).map_err(sql_error)?,
            };
            submission.validate()?;
            page.entries.push(Entry {
                id: u64::try_from(row.get::<_, i64>(0).map_err(sql_error)?)
                    .map_err(|_| "Invalid input history identity")?,
                submitted_at_ms: u64::try_from(row.get::<_, i64>(1).map_err(sql_error)?)
                    .map_err(|_| "Invalid input history timestamp")?,
                submission,
            });
        }
        Ok(page)
    }

    fn clear(&self) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Input history lock poisoned")?;
        connection
            .execute("DELETE FROM message_history", [])
            .map_err(sql_error)?;
        Ok(())
    }
}

fn kind_name(kind: InputKind) -> &'static str {
    match kind {
        InputKind::Agent => "agent",
        InputKind::Shell => "shell",
        InputKind::Command => "command",
    }
}

fn prune(connection: &Connection, retention: Retention) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM message_history WHERE id IN (
             SELECT id FROM (
                 SELECT id, row_number() OVER (ORDER BY id DESC) AS position,
                        sum(text_bytes) OVER (ORDER BY id DESC) AS retained_bytes
                 FROM message_history
             ) WHERE position > 1 AND (position > ?1 OR retained_bytes > ?2)
         )",
            (retention.max_entries, retention.max_bytes as i64),
        )
        .map_err(sql_error)?;
    Ok(())
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("SQLite input history: {error}")
}

#[cfg(test)]
#[path = "message_history_tests.rs"]
mod tests;
