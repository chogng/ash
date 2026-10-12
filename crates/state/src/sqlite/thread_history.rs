use super::connection::from_sql_integer;
use super::connection::sql_error;
use super::connection::to_sql_integer;
use ash_protocol::ContentDigest;
use ash_protocol::ThreadId;
use ash_thread_store::ThreadHistoryIndexMode;
use ash_thread_store::ThreadHistoryIndexUpdate;
use ash_thread_store::ThreadHistoryPage;
use ash_thread_store::ThreadHistoryWindow;
use ash_thread_store::ThreadStoreError;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize)]
struct Header {
    thread: ash_protocol::Thread,
    turn_count: usize,
    pending_interactions: Vec<ash_protocol::AgentRequestEnvelope>,
}

fn error(value: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(sql_error(value))
}

pub(super) fn create_schema(connection: &mut Connection) -> Result<(), ThreadStoreError> {
    let version = connection
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = 'thread-history-index'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(error)?;
    if version == Some(2) {
        return Ok(());
    }
    if version.is_some_and(|version| version != 1) {
        return Err(error("unsupported Thread history index version"));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let locked = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = 'thread-history-index'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(error)?;
    if locked == Some(2) {
        return transaction.commit().map_err(error);
    }
    if locked.is_some_and(|version| version != 1) {
        return Err(error("unsupported Thread history index version"));
    }
    if locked == Some(1) {
        // This cache is rebuilt from canonical events; the old whole-Turn encoding is disposable.
        transaction.execute_batch("DROP TABLE IF EXISTS thread_history_items; DROP TABLE thread_history_turns; DELETE FROM thread_history_index;").map_err(error)?;
    }
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS thread_history_index (
            thread_id TEXT PRIMARY KEY REFERENCES thread_streams(thread_id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, header_json TEXT NOT NULL, header_digest TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS thread_history_turns (
            thread_id TEXT NOT NULL REFERENCES thread_history_index(thread_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL, turn_json TEXT NOT NULL, turn_digest TEXT NOT NULL, item_count INTEGER NOT NULL,
            PRIMARY KEY(thread_id, turn_id), UNIQUE(thread_id, ordinal)
         );
         CREATE TABLE IF NOT EXISTS thread_history_items (
            thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            item_json TEXT NOT NULL, item_digest TEXT NOT NULL,
            PRIMARY KEY(thread_id, turn_id, ordinal),
            FOREIGN KEY(thread_id, turn_id) REFERENCES thread_history_turns(thread_id, turn_id) ON DELETE CASCADE
         );
         INSERT INTO ash_schema_migrations(component, version) VALUES ('thread-history-index', 2)
         ON CONFLICT(component) DO UPDATE SET version = excluded.version;"
    ).map_err(error)?;
    transaction.commit().map_err(error)
}

pub(super) fn sequence(
    connection: &Connection,
    thread_id: &ThreadId,
) -> Result<Option<u64>, ThreadStoreError> {
    connection
        .query_row(
            "SELECT sequence FROM thread_history_index WHERE thread_id = ?1",
            [thread_id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(error)?
        .map(|sequence| from_sql_integer(sequence).map_err(error))
        .transpose()
}

pub(super) fn write(
    connection: &Connection,
    index: &ThreadHistoryIndexUpdate,
    expected: u64,
) -> Result<(), ThreadStoreError> {
    let thread_id = &index.thread.thread_id;
    if index.mode == ThreadHistoryIndexMode::Update
        && sequence(connection, thread_id)? != Some(expected)
    {
        return Err(error("Thread history index update has no matching base"));
    }
    let header = Header {
        thread: index.thread.clone(),
        turn_count: index.turn_count,
        pending_interactions: index.pending_interactions.clone(),
    };
    let json = serde_json::to_string(&header).map_err(error)?;
    connection.execute(
        "INSERT INTO thread_history_index(thread_id, sequence, header_json, header_digest) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(thread_id) DO UPDATE SET sequence=excluded.sequence, header_json=excluded.header_json, header_digest=excluded.header_digest",
        params![thread_id.as_str(), to_sql_integer(index.thread.sequence).map_err(error)?, json,
            ContentDigest::sha256(json.as_bytes()).as_str()]).map_err(error)?;
    if index.mode == ThreadHistoryIndexMode::Replace {
        connection
            .execute(
                "DELETE FROM thread_history_turns WHERE thread_id = ?1",
                [thread_id.as_str()],
            )
            .map_err(error)?;
    }
    for entry in &index.turns {
        let old_count = connection
            .query_row(
                "SELECT item_count FROM thread_history_turns WHERE thread_id = ?1 AND turn_id = ?2",
                params![thread_id.as_str(), entry.turn.turn_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(error)?
            .unwrap_or(0);
        let old_count = usize::try_from(old_count).map_err(error)?;
        if old_count > entry.turn.items.len() {
            return Err(error("Thread history items are not append-only"));
        }
        let json = serde_json::to_string(&turn_metadata(&entry.turn)).map_err(error)?;
        connection.execute(
            "INSERT INTO thread_history_turns(thread_id, turn_id, ordinal, turn_json, turn_digest, item_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(thread_id, turn_id) DO UPDATE SET ordinal=excluded.ordinal, turn_json=excluded.turn_json, turn_digest=excluded.turn_digest, item_count=excluded.item_count",
            params![thread_id.as_str(), entry.turn.turn_id.as_str(), i64::try_from(entry.ordinal).map_err(error)?, json,
                ContentDigest::sha256(json.as_bytes()).as_str(), i64::try_from(entry.turn.items.len()).map_err(error)?]).map_err(error)?;
        // Completed items are immutable. Metadata changes and new items never rewrite old bodies.
        for (ordinal, item) in entry.turn.items.iter().enumerate().skip(old_count) {
            let json = serde_json::to_string(item).map_err(error)?;
            connection.execute("INSERT INTO thread_history_items(thread_id, turn_id, ordinal, item_json, item_digest) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![thread_id.as_str(), entry.turn.turn_id.as_str(), i64::try_from(ordinal).map_err(error)?, json,
                    ContentDigest::sha256(json.as_bytes()).as_str()]).map_err(error)?;
        }
    }
    Ok(())
}

pub(super) fn read(
    connection: &Connection,
    thread_id: &ThreadId,
    window: &ThreadHistoryWindow,
) -> Result<Option<ThreadHistoryPage>, ThreadStoreError> {
    let row = connection.query_row(
        "SELECT cache.sequence, cache.header_json, cache.header_digest, streams.current_sequence
         FROM thread_history_index AS cache JOIN thread_streams AS streams USING(thread_id) WHERE thread_id = ?1",
        [thread_id.as_str()], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))
        .optional().map_err(error)?;
    let Some((sequence, json, digest, current)) = row else {
        return Ok(None);
    };
    if sequence != current || ContentDigest::sha256(json.as_bytes()).as_str() != digest {
        return Ok(None);
    }
    let Ok(mut header) = serde_json::from_str::<Header>(&json) else {
        return Ok(None);
    };
    if header.thread.sequence != from_sql_integer(current).map_err(error)?
        || header.thread.thread_id != *thread_id
        || !header.thread.turns.is_empty()
    {
        return Ok(None);
    }
    let (end, limit) = match window {
        ThreadHistoryWindow::Latest { turn_limit } => {
            (header.turn_count, turn_limit.get() as usize)
        }
        ThreadHistoryWindow::Before {
            turn_id,
            turn_limit,
        } => {
            let ordinal = connection.query_row("SELECT ordinal FROM thread_history_turns WHERE thread_id = ?1 AND turn_id = ?2",
                params![thread_id.as_str(), turn_id.as_str()], |row| row.get::<_, i64>(0)).optional().map_err(error)?
                .ok_or_else(|| ThreadStoreError::InvalidBatch("unknown history Turn".into()))?;
            (
                usize::try_from(ordinal).map_err(error)?,
                turn_limit.get() as usize,
            )
        }
    };
    if end > header.turn_count {
        return Ok(None);
    }
    let start = end.saturating_sub(limit);
    let mut statement = connection
        .prepare(
            "SELECT ordinal, turn_id, turn_json, turn_digest, item_count FROM thread_history_turns
         WHERE thread_id = ?1 AND ordinal >= ?2 AND ordinal < ?3 ORDER BY ordinal",
        )
        .map_err(error)?;
    let rows = statement
        .query_map(
            params![
                thread_id.as_str(),
                i64::try_from(start).map_err(error)?,
                i64::try_from(end).map_err(error)?
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(error)?;
    for row in rows {
        let (ordinal, turn_id, json, digest, item_count) = row.map_err(error)?;
        let Ok(mut turn) = serde_json::from_str::<ash_protocol::Turn>(&json) else {
            return Ok(None);
        };
        if ContentDigest::sha256(json.as_bytes()).as_str() != digest
            || turn.turn_id.as_str() != turn_id
            || usize::try_from(ordinal).map_err(error)? != start + header.thread.turns.len()
            || !turn.items.is_empty()
        {
            return Ok(None);
        }
        let mut items = connection.prepare("SELECT ordinal, item_json, item_digest FROM thread_history_items WHERE thread_id = ?1 AND turn_id = ?2 ORDER BY ordinal").map_err(error)?;
        let rows = items
            .query_map(params![thread_id.as_str(), turn_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error)?;
        for row in rows {
            let (ordinal, json, digest) = row.map_err(error)?;
            let Ok(item) = serde_json::from_str::<ash_protocol::ThreadItem>(&json) else {
                return Ok(None);
            };
            if ContentDigest::sha256(json.as_bytes()).as_str() != digest
                || item.turn_id() != &turn.turn_id
                || usize::try_from(ordinal).ok() != Some(turn.items.len())
            {
                return Ok(None);
            }
            turn.items.push(item);
        }
        if usize::try_from(item_count).ok() != Some(turn.items.len()) {
            return Ok(None);
        }
        header.thread.turns.push(turn);
    }
    if header.thread.turns.len() != end - start {
        return Ok(None);
    }
    Ok(Some(ThreadHistoryPage {
        thread: header.thread,
        has_older_turns: start > 0,
        pending_interactions: header.pending_interactions,
    }))
}

fn turn_metadata(turn: &ash_protocol::Turn) -> ash_protocol::Turn {
    ash_protocol::Turn {
        turn_id: turn.turn_id.clone(),
        status: turn.status,
        kind: turn.kind,
        mode: turn.mode,
        instructions: turn.instructions.clone(),
        model: turn.model.clone(),
        reasoning_effort: turn.reasoning_effort,
        advisor: turn.advisor.clone(),
        tool_profile: turn.tool_profile.clone(),
        tool_mode: turn.tool_mode,
        approval_mode: turn.approval_mode,
        usage: turn.usage.clone(),
        context_usage: turn.context_usage.clone(),
        items: Vec::new(),
        plan: turn.plan.clone(),
        pending_interaction: turn.pending_interaction.clone(),
        error: turn.error.clone(),
    }
}
