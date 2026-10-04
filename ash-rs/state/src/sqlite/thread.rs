use super::connection::{from_sql_integer, open, sql_error, to_sql_integer};
use ash_history::StoredEvent;
use ash_history::supports_stored_event_schema_version;
use ash_protocol::ContentDigest;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_thread_store::AppendBatchResult;
use ash_thread_store::ThreadCatalogRecord;
use ash_thread_store::ThreadEventBatch;
use ash_thread_store::ThreadStore;
use ash_thread_store::ThreadStoreError;
use ash_thread_store::session_from_catalog;
use ash_thread_store::validate_append_batch;
use rusqlite::{Connection, OptionalExtension, ToSql, TransactionBehavior, params};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// SQLite implementation of the authoritative typed Thread event store.
pub struct SqliteThreadStore {
    path: PathBuf,
    connection: Mutex<Connection>,
    catalog_connection: Mutex<Connection>,
}

impl SqliteThreadStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ThreadStoreError> {
        let path = path.into();
        let connection = open(&path).map_err(ThreadStoreError::Storage)?;
        let catalog_connection = open(&path).map_err(ThreadStoreError::Storage)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
            catalog_connection: Mutex::new(catalog_connection),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Finds legacy Threads that still need a catalog row without reading their histories.
    pub fn missing_catalog_thread_ids(&self) -> Result<Vec<ThreadId>, ThreadStoreError> {
        self.catalog_thread_ids(
            "SELECT streams.thread_id FROM thread_streams AS streams
             WHERE streams.current_sequence > 0 AND NOT EXISTS (
                 SELECT 1 FROM thread_catalog AS catalog
                 WHERE catalog.thread_id = streams.thread_id AND catalog.record_version = 2
             ) ORDER BY streams.thread_id",
        )
    }

    /// Finds only Threads with durable work that must resume during startup.
    pub fn startup_recovery_thread_ids(&self) -> Result<Vec<ThreadId>, ThreadStoreError> {
        self.catalog_thread_ids(
            "SELECT thread_id FROM thread_catalog
             WHERE requires_startup_recovery = 1 ORDER BY session_id, thread_id",
        )
    }

    fn catalog_thread_ids(&self, sql: &str) -> Result<Vec<ThreadId>, ThreadStoreError> {
        let connection = self.catalog_connection()?;
        let mut statement = connection.prepare(sql).map_err(storage_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| ThreadId::new(row.map_err(storage_error)?).map_err(storage_error))
            .collect()
    }

    fn catalog_connection(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, ThreadStoreError> {
        self.catalog_connection
            .lock()
            .map_err(|_| ThreadStoreError::Storage("Thread catalog SQLite lock poisoned".into()))
    }
}

impl ThreadStore for SqliteThreadStore {
    fn recent_tool_calls(
        &self,
        query: &ash_thread_store::RecentToolCallsQuery,
    ) -> Result<ash_thread_store::RecentToolCalls, ThreadStoreError> {
        let connection = self.connection()?;
        // Rank within Sessions before applying aggregate budgets. Each selected Session gets its
        // newest command first; a busy chat cannot consume the entire history scan.
        let mut statement = connection.prepare(
            "WITH local_threads AS MATERIALIZED (
                SELECT catalog.session_id, catalog.thread_id FROM thread_catalog AS catalog
                WHERE json_extract(catalog.record_json, '$.execution_target.type') = 'local'
                  AND json_extract(catalog.record_json, '$.execution_target.root') = ?1
                  AND NOT EXISTS (SELECT 1 FROM remote_history_bindings AS remote
                                  WHERE remote.thread_id = catalog.thread_id)
            ), completed AS MATERIALIZED (
                SELECT events.thread_id,
                       json_extract(records.record_json, '$.event.item.toolCallId') AS call_id,
                       json_extract(records.record_json, '$.event.item.turnId') AS turn_id,
                       MAX(events.sequence) AS sequence
                FROM local_threads AS threads
                JOIN thread_events AS events ON events.thread_id = threads.thread_id
                JOIN history_records AS records ON records.digest = events.record_digest
                WHERE json_extract(records.record_json, '$.event.type') = 'itemCompleted'
                  AND json_extract(records.record_json, '$.event.item.type') = 'toolResult'
                  AND json_extract(records.record_json, '$.event.item.isError') = 0
                  AND json_extract(records.record_json, '$.recordedAt') <= ?3
                GROUP BY events.thread_id, call_id, turn_id
            ), eligible AS MATERIALIZED (
                SELECT threads.session_id, events.thread_id, events.sequence,
                       records.record_json, records.digest,
                       json_extract(records.record_json, '$.recordedAt') AS recorded_at,
                       length(CAST(json_extract(records.record_json, '$.event.item.argumentsJson') AS BLOB)) AS bytes
                FROM local_threads AS threads
                JOIN thread_events AS events ON events.thread_id = threads.thread_id
                JOIN history_records AS records ON records.digest = events.record_digest
                JOIN completed ON completed.thread_id = events.thread_id
                  AND completed.call_id = json_extract(records.record_json, '$.event.item.toolCallId')
                  AND completed.turn_id = json_extract(records.record_json, '$.event.item.turnId')
                  AND completed.sequence > events.sequence
                WHERE json_extract(records.record_json, '$.recordedAt') BETWEEN ?2 AND ?3
                  AND json_extract(records.record_json, '$.event.type') = 'itemCompleted'
                  AND json_extract(records.record_json, '$.event.item.type') = 'toolCall'
                  AND json_extract(records.record_json, '$.event.item.name')
                      IN ('exec_command', 'shell', 'run_command', 'shell-command', 'shell-session')
                  AND bytes <= ?4
            ), recent_sessions AS (
                SELECT session_id FROM eligible GROUP BY session_id
                ORDER BY MAX(recorded_at) DESC, session_id LIMIT ?5
            ), ranked AS (
                SELECT eligible.*, ROW_NUMBER() OVER (
                    PARTITION BY session_id ORDER BY recorded_at DESC, thread_id, sequence DESC
                ) AS command_rank
                FROM eligible WHERE session_id IN (SELECT session_id FROM recent_sessions)
            ), budgeted AS (
                SELECT ranked.*, SUM(bytes) OVER (
                    ORDER BY command_rank, recorded_at DESC, session_id, thread_id, sequence DESC
                    ROWS UNBOUNDED PRECEDING
                ) AS total_bytes,
                ROW_NUMBER() OVER (
                    ORDER BY command_rank, recorded_at DESC, session_id, thread_id, sequence DESC
                ) AS total_rank
                FROM ranked WHERE command_rank <= ?6
            ), coverage AS (
                SELECT (SELECT COUNT(DISTINCT session_id) FROM eligible) AS sessions_available,
                       (SELECT COUNT(*) FROM ranked) AS commands_available
            )
            SELECT budgeted.session_id, budgeted.thread_id, budgeted.sequence,
                   budgeted.record_json, budgeted.digest,
                   coverage.sessions_available, coverage.commands_available
            FROM coverage LEFT JOIN budgeted ON total_bytes <= ?7 AND total_rank <= ?8
            ORDER BY command_rank, recorded_at DESC, session_id, thread_id, sequence DESC"
        ).map_err(storage_error)?;
        let rows = statement
            .query_map(
                params![
                    query
                        .root
                        .to_str()
                        .ok_or_else(|| storage_error("history root is not UTF-8"))?,
                    to_sql_integer(query.since_unix_ms).map_err(ThreadStoreError::Storage)?,
                    to_sql_integer(query.until_unix_ms).map_err(ThreadStoreError::Storage)?,
                    ash_thread_store::MAX_RECENT_ARGUMENT_BYTES as i64,
                    i64::from(query.sessions),
                    i64::from(query.commands_per_session),
                    ash_thread_store::MAX_RECENT_ARGUMENT_TOTAL_BYTES as i64,
                    ash_thread_store::MAX_RECENT_TOOL_CALLS as i64,
                ],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .map_err(storage_error)?;
        let mut result = ash_thread_store::RecentToolCalls::default();
        for row in rows {
            let (session_id, thread_id, sequence, json, digest, sessions, commands) =
                row.map_err(storage_error)?;
            result.sessions_available =
                from_sql_integer(sessions).map_err(ThreadStoreError::Storage)?;
            result.commands_available =
                from_sql_integer(commands).map_err(ThreadStoreError::Storage)?;
            if let (Some(session_id), Some(thread_id), Some(sequence), Some(json), Some(digest)) =
                (session_id, thread_id, sequence, json, digest)
            {
                let event = super::history::decode_record(&json, &digest)?;
                if event.thread_id.as_str() != thread_id
                    || event.sequence
                        != from_sql_integer(sequence).map_err(ThreadStoreError::Storage)?
                {
                    return Err(storage_error(
                        "history metadata disagrees with its envelope",
                    ));
                }
                let session_id = SessionId::new(session_id).map_err(storage_error)?;
                if let Some(call) =
                    ash_thread_store::RecentToolCall::from_event(&session_id, &event)
                {
                    result.calls.push(call);
                }
            }
        }
        Ok(result)
    }
    fn execution_binding(
        &self,
        thread_id: &ThreadId,
    ) -> Result<ash_thread_store::ThreadExecutionBinding, ThreadStoreError> {
        super::handoff::execution_binding(&*self.connection()?, thread_id)
    }
    fn pending_checkpoint_cleanup(
        &self,
    ) -> Result<Vec<(String, ash_protocol::RepositoryCheckpoint)>, ThreadStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT cleanup_key, checkpoint_json FROM history_checkpoint_cleanup ORDER BY cleanup_key").map_err(storage_error)?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(storage_error)?
            .map(|row| {
                let (key, json) = row.map_err(storage_error)?;
                Ok((key, serde_json::from_str(&json).map_err(storage_error)?))
            })
            .collect()
    }
    fn acknowledge_checkpoint_cleanup(&self, key: &str) -> Result<(), ThreadStoreError> {
        self.connection()?
            .execute(
                "DELETE FROM history_checkpoint_cleanup WHERE cleanup_key = ?1",
                [key],
            )
            .map_err(storage_error)?;
        Ok(())
    }
    fn load_history_prefix(
        &self,
        prefix: &ash_protocol::HistoryPrefixRef,
    ) -> Result<ash_history::HistoryPrefix, ThreadStoreError> {
        super::history::read_prefix(&*self.connection()?, prefix)
    }
    fn list_session_thread_ids(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadId>, ThreadStoreError> {
        let connection = self.catalog_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT thread_id FROM thread_catalog WHERE session_id = ?1 ORDER BY thread_id",
            )
            .map_err(storage_error)?;
        statement
            .query_map([session_id.as_str()], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| ThreadId::new(row.map_err(storage_error)?).map_err(storage_error))
            .collect()
    }
    fn list_thread_ids(&self) -> Result<Vec<ThreadId>, ThreadStoreError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT thread_id FROM thread_streams
                 WHERE current_sequence > 0 ORDER BY thread_id",
            )
            .map_err(storage_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| {
                ThreadId::new(row.map_err(storage_error)?)
                    .map_err(|error| ThreadStoreError::Storage(error.to_string()))
            })
            .collect()
    }

    fn list_catalog(&self) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError> {
        let connection = self.catalog_connection()?;
        query_catalog(
            &connection,
            "ORDER BY catalog.session_id, catalog.thread_id",
            &[],
        )
    }

    fn list_sessions(&self) -> Result<Vec<Session>, ThreadStoreError> {
        let connection = self.catalog_connection()?;
        let missing = connection
            .query_row(
                "SELECT catalog.session_id FROM thread_catalog AS catalog
                 WHERE NOT EXISTS (
                     SELECT 1 FROM session_catalog AS sessions
                     WHERE sessions.session_id = catalog.session_id
                 ) LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some(session_id) = missing {
            return Err(ThreadStoreError::SessionCatalogDamaged(
                SessionId::new(session_id).map_err(storage_error)?,
            ));
        }
        let mut statement = connection
            .prepare(
                "SELECT session_id, record_json, record_version, record_digest
                 FROM session_catalog ORDER BY session_id",
            )
            .map_err(storage_error)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(storage_error)?
            .map(|row| {
                let (session_id, json, version, digest) = row.map_err(storage_error)?;
                let session_id = SessionId::new(session_id).map_err(storage_error)?;
                decode_session_catalog(&connection, &session_id, &json, version, &digest)
            })
            .collect()
    }

    fn read_session(&self, session_id: &SessionId) -> Result<Option<Session>, ThreadStoreError> {
        let connection = self.catalog_connection()?;
        let row = connection
            .query_row(
                "SELECT record_json, record_version, record_digest
                 FROM session_catalog WHERE session_id = ?1",
                [session_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((json, version, digest)) = row {
            return decode_session_catalog(&connection, session_id, &json, version, &digest)
                .map(Some);
        }
        let has_threads = connection
            .query_row(
                "SELECT 1 FROM thread_catalog WHERE session_id = ?1 LIMIT 1",
                [session_id.as_str()],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some();
        if has_threads {
            Err(ThreadStoreError::SessionCatalogDamaged(session_id.clone()))
        } else {
            Ok(None)
        }
    }

    fn session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError> {
        let connection = self.catalog_connection()?;
        query_catalog(
            &connection,
            "WHERE catalog.session_id = ?1 ORDER BY catalog.thread_id",
            &[&session_id.as_str() as &dyn ToSql],
        )
    }

    fn backfill_catalog(&self, record: &ThreadCatalogRecord) -> Result<(), ThreadStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let current_sequence = transaction
            .query_row(
                "SELECT current_sequence FROM thread_streams WHERE thread_id = ?1",
                [record.thread.thread_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)
            .and_then(|value| from_sql_integer(value).map_err(ThreadStoreError::Storage))?;
        if current_sequence != record.sequence {
            return Err(ThreadStoreError::SequenceConflict {
                expected: record.sequence,
                actual: current_sequence,
            });
        }
        write_catalog(&transaction, record)?;
        match write_session_catalog(&transaction, &record.session_id) {
            Ok(()) => {}
            Err(ThreadStoreError::CatalogDamaged(_)) => {
                transaction
                    .execute(
                        "DELETE FROM session_catalog WHERE session_id = ?1",
                        [record.session_id.as_str()],
                    )
                    .map_err(storage_error)?;
            }
            Err(error) => return Err(error),
        }
        super::graph::write_binding(&transaction, record)?;
        transaction.commit().map_err(storage_error)
    }

    fn rebuild_session(&self, session_id: &SessionId) -> Result<(), ThreadStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        write_session_catalog(&transaction, session_id)?;
        transaction.commit().map_err(storage_error)
    }

    fn delete_session(&self, session_id: &SessionId) -> Result<Vec<ThreadId>, ThreadStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let thread_ids = {
            let mut statement = transaction
                .prepare(
                    "SELECT thread_id FROM thread_catalog
                     WHERE session_id = ?1 ORDER BY thread_id",
                )
                .map_err(storage_error)?;
            statement
                .query_map([session_id.as_str()], |row| row.get::<_, String>(0))
                .map_err(storage_error)?
                .map(|row| {
                    ThreadId::new(row.map_err(storage_error)?)
                        .map_err(|error| ThreadStoreError::Storage(error.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        for thread_id in &thread_ids {
            transaction
                .execute(
                    "DELETE FROM thread_history_prefixes WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM agent_threads WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM turn_change_sets WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM thread_catalog WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM thread_events WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM thread_batches WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "DELETE FROM thread_streams WHERE thread_id = ?1",
                    [thread_id.as_str()],
                )
                .map_err(storage_error)?;
        }
        transaction
            .execute(
                "DELETE FROM session_catalog WHERE session_id = ?1",
                [session_id.as_str()],
            )
            .map_err(storage_error)?;
        super::history::collect(&transaction)?;
        transaction.commit().map_err(storage_error)?;
        Ok(thread_ids)
    }

    fn load(&self, thread_id: &ThreadId) -> Result<Vec<StoredEvent>, ThreadStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(storage_error)?;
        let current_sequence = transaction
            .query_row(
                "SELECT current_sequence FROM thread_streams WHERE thread_id = ?1",
                [thread_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(storage_error)?
            .map(from_sql_integer)
            .transpose()
            .map_err(ThreadStoreError::Storage)?;
        let events = {
            let mut statement = transaction
                .prepare(
                    "SELECT events.sequence, events.event_id, events.schema_version, records.record_json, records.digest
                     FROM thread_events AS events JOIN history_records AS records ON records.digest = events.record_digest WHERE events.thread_id = ?1 ORDER BY events.sequence",
                )
                .map_err(storage_error)?;
            let rows = statement
                .query_map([thread_id.as_str()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(storage_error)?;
            let mut events = Vec::new();
            for row in rows {
                let (sequence, event_id, schema_version, envelope, digest) =
                    row.map_err(storage_error)?;
                let sequence = from_sql_integer(sequence).map_err(ThreadStoreError::Storage)?;
                let event = super::history::decode_record(&envelope, &digest)?;
                if event.sequence != sequence
                    || event.event_id.0 != event_id
                    || event.schema_version != schema_version
                {
                    return Err(ThreadStoreError::Storage(
                        "Thread history row metadata disagrees with its envelope".into(),
                    ));
                }
                events.push(event);
            }
            events
        };
        validate_loaded(thread_id, &events)?;
        let loaded_sequence = events.last().map_or(0, |event| event.sequence);
        match current_sequence {
            Some(current_sequence) if current_sequence == loaded_sequence => {}
            None if events.is_empty() => {}
            _ => {
                return Err(ThreadStoreError::Storage(
                    "Thread stream sequence disagrees with its durable event tail".into(),
                ));
            }
        }
        transaction.commit().map_err(storage_error)?;
        Ok(events)
    }

    fn append_batch(
        &self,
        batch: &ThreadEventBatch,
    ) -> Result<AppendBatchResult, ThreadStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO thread_streams (thread_id, current_sequence)
                 VALUES (?1, 0)",
                [batch.thread_id.as_str()],
            )
            .map_err(storage_error)?;
        let actual = transaction
            .query_row(
                "SELECT current_sequence FROM thread_streams WHERE thread_id = ?1",
                [batch.thread_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)
            .and_then(|value| from_sql_integer(value).map_err(ThreadStoreError::Storage))?;
        let result = validate_append_batch(batch, actual)?;
        for prefix in &batch.history_prefixes {
            super::history::write_prefix(&transaction, prefix)?;
        }
        let duplicate_batch = transaction
            .query_row(
                "SELECT 1 FROM thread_batches WHERE thread_id = ?1 AND batch_id = ?2",
                params![batch.thread_id.as_str(), batch.batch_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some();
        if duplicate_batch {
            return Err(ThreadStoreError::InvalidBatch(
                "batch ID already exists".into(),
            ));
        }
        for event in &batch.events {
            let duplicate_event = transaction
                .query_row(
                    "SELECT 1 FROM thread_events WHERE event_id = ?1",
                    [&event.event_id.0],
                    |_| Ok(()),
                )
                .optional()
                .map_err(storage_error)?
                .is_some();
            if duplicate_event {
                return Err(ThreadStoreError::InvalidBatch(
                    "event ID already exists".into(),
                ));
            }
        }
        transaction
            .execute(
                "INSERT INTO thread_batches
                 (thread_id, batch_id, expected_sequence, event_count)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    batch.thread_id.as_str(),
                    batch.batch_id,
                    to_sql_integer(batch.expected_sequence).map_err(ThreadStoreError::Storage)?,
                    to_sql_integer(batch.events.len() as u64).map_err(ThreadStoreError::Storage)?,
                ],
            )
            .map_err(storage_error)?;
        for event in &batch.events {
            let record_digest = super::history::write_record(&transaction, event)?;
            super::history::bind_prefix(&transaction, event)?;
            transaction
                .execute(
                    "INSERT INTO thread_events
                     (thread_id, sequence, event_id, schema_version, record_digest)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        batch.thread_id.as_str(),
                        to_sql_integer(event.sequence).map_err(ThreadStoreError::Storage)?,
                        event.event_id.0,
                        event.schema_version,
                        record_digest,
                    ],
                )
                .map_err(storage_error)?;
        }
        let updated = transaction
            .execute(
                "UPDATE thread_streams SET current_sequence = ?1
                 WHERE thread_id = ?2 AND current_sequence = ?3",
                params![
                    to_sql_integer(result.committed_sequence).map_err(ThreadStoreError::Storage)?,
                    batch.thread_id.as_str(),
                    to_sql_integer(batch.expected_sequence).map_err(ThreadStoreError::Storage)?,
                ],
            )
            .map_err(storage_error)?;
        if updated != 1 {
            return Err(ThreadStoreError::SequenceConflict {
                expected: batch.expected_sequence,
                actual,
            });
        }
        let session_changed = session_list_changed(&transaction, &batch.catalog)?;
        write_catalog(&transaction, &batch.catalog)?;
        if session_changed {
            write_session_catalog(&transaction, &batch.catalog.session_id)?;
        }
        super::graph::write_binding(&transaction, &batch.catalog)?;
        if batch.expected_sequence == 0
            && let Some(source) = batch.catalog.binding.source_thread_id()
        {
            // Forks and delegated branches retain imported execution authority, including an
            // unknown root. Otherwise making a branch would turn an unbound remote history
            // into an ordinary local Thread and bypass its explicit binding requirement.
            transaction
                .execute(
                    "INSERT INTO remote_history_bindings (thread_id, source, host, root)
                 SELECT ?1, source, host, root FROM remote_history_bindings WHERE thread_id = ?2",
                    params![batch.thread_id.as_str(), source.as_str()],
                )
                .map_err(storage_error)?;
        }
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }
}

fn query_catalog(
    connection: &Connection,
    filter: &str,
    params: &[&dyn ToSql],
) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT catalog.thread_id, catalog.session_id, catalog.requires_startup_recovery,
                catalog.record_json, catalog.record_version, catalog.record_digest,
                streams.current_sequence
         FROM thread_catalog AS catalog
         JOIN thread_streams AS streams ON streams.thread_id = catalog.thread_id
         {filter}"
        ))
        .map_err(storage_error)?;
    statement
        .query_map(params, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(storage_error)?
        .map(|row| {
            let (
                thread_id,
                session_id,
                requires_recovery,
                record_json,
                record_version,
                record_digest,
                current_sequence,
            ) = row.map_err(storage_error)?;
            let catalog_thread_id = ThreadId::new(thread_id.clone()).map_err(storage_error)?;
            if record_version != 2
                || ContentDigest::sha256(record_json.as_bytes()).as_str() != record_digest
            {
                return Err(ThreadStoreError::CatalogDamaged(catalog_thread_id));
            }
            let mut record = serde_json::from_str::<ThreadCatalogRecord>(&record_json)
                .map_err(|_| ThreadStoreError::CatalogDamaged(catalog_thread_id.clone()))?;
            let current_sequence =
                from_sql_integer(current_sequence).map_err(ThreadStoreError::Storage)?;
            if record.thread.thread_id.as_str() != thread_id
                || record.session_id.as_str() != session_id
                || i64::from(record.requires_startup_recovery) != requires_recovery
                || record.sequence != current_sequence
            {
                return Err(ThreadStoreError::CatalogDamaged(catalog_thread_id));
            }
            super::handoff::execution_binding(connection, &record.thread.thread_id)?
                .apply(&mut record.execution_target);
            Ok(record)
        })
        .collect()
}

fn write_catalog(
    connection: &Connection,
    record: &ThreadCatalogRecord,
) -> Result<(), ThreadStoreError> {
    let json = serde_json::to_string(record)
        .map_err(|error| ThreadStoreError::Storage(error.to_string()))?;
    let digest = ContentDigest::sha256(json.as_bytes());
    connection
        .execute(
            "INSERT INTO thread_catalog
             (thread_id, session_id, requires_startup_recovery, record_json, record_version, record_digest)
             VALUES (?1, ?2, ?3, ?4, 2, ?5)
             ON CONFLICT(thread_id) DO UPDATE SET
                 session_id = excluded.session_id,
                 requires_startup_recovery = excluded.requires_startup_recovery,
                 record_json = excluded.record_json,
                 record_version = excluded.record_version,
                 record_digest = excluded.record_digest",
            params![
                record.thread.thread_id.as_str(),
                record.session_id.as_str(),
                record.requires_startup_recovery,
                json,
                digest.as_str(),
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn session_list_changed(
    connection: &Connection,
    record: &ThreadCatalogRecord,
) -> Result<bool, ThreadStoreError> {
    let previous = connection
        .query_row(
            "SELECT record_json, record_version, record_digest FROM thread_catalog
             WHERE thread_id = ?1",
            [record.thread.thread_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?;
    let Some((json, version, digest)) = previous else {
        return Ok(true);
    };
    if version != 2 || ContentDigest::sha256(json.as_bytes()).as_str() != digest {
        return Ok(true);
    }
    let Ok(previous) = serde_json::from_str::<ThreadCatalogRecord>(&json) else {
        return Ok(true);
    };
    Ok(previous.session_id != record.session_id
        || previous.thread != record.thread
        || previous.manager != record.manager
        || previous.archived_at_unix_ms != record.archived_at_unix_ms
        || previous.stopped != record.stopped)
}

fn decode_session_catalog(
    connection: &Connection,
    session_id: &SessionId,
    json: &str,
    version: i64,
    digest: &str,
) -> Result<Session, ThreadStoreError> {
    if version != 2 || ContentDigest::sha256(json.as_bytes()).as_str() != digest {
        return Err(ThreadStoreError::SessionCatalogDamaged(session_id.clone()));
    }
    let mut session = serde_json::from_str::<Session>(json)
        .map_err(|_| ThreadStoreError::SessionCatalogDamaged(session_id.clone()))?;
    if &session.session_id != session_id {
        return Err(ThreadStoreError::SessionCatalogDamaged(session_id.clone()));
    }
    let mut statement = connection.prepare("SELECT bindings.host, bindings.root FROM remote_history_bindings AS bindings JOIN thread_catalog AS catalog USING(thread_id) WHERE catalog.session_id = ?1 ORDER BY (catalog.thread_id = catalog.session_id) DESC, catalog.thread_id LIMIT 1").map_err(storage_error)?;
    let binding: Option<(String, Option<String>)> = statement
        .query_row([session_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(storage_error)?;
    if let Some((host, root)) = binding {
        ash_thread_store::ThreadExecutionBinding::Remote { host, root }
            .apply(&mut session.execution_target);
    }
    Ok(session)
}

pub(super) fn write_session_catalog(
    connection: &Connection,
    session_id: &SessionId,
) -> Result<(), ThreadStoreError> {
    let records = query_catalog(
        connection,
        "WHERE catalog.session_id = ?1 ORDER BY catalog.thread_id",
        &[&session_id.as_str() as &dyn ToSql],
    )?;
    if records.is_empty() {
        connection
            .execute(
                "DELETE FROM session_catalog WHERE session_id = ?1",
                [session_id.as_str()],
            )
            .map_err(storage_error)?;
        return Ok(());
    }
    let session = session_from_catalog(records)?;
    let json = serde_json::to_string(&session).map_err(storage_error)?;
    let digest = ContentDigest::sha256(json.as_bytes());
    connection
        .execute(
            "INSERT INTO session_catalog (session_id, record_json, record_version, record_digest)
             VALUES (?1, ?2, 2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
                 record_json = excluded.record_json,
                 record_version = excluded.record_version,
                 record_digest = excluded.record_digest",
            params![session_id.as_str(), json, digest.as_str()],
        )
        .map_err(storage_error)?;
    Ok(())
}

impl SqliteThreadStore {
    pub(super) fn connection(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Connection>, ThreadStoreError> {
        self.connection
            .lock()
            .map_err(|_| ThreadStoreError::Storage("Thread SQLite lock poisoned".into()))
    }
}

fn validate_loaded(thread_id: &ThreadId, events: &[StoredEvent]) -> Result<(), ThreadStoreError> {
    validate_history_records(thread_id, events)
}

fn validate_history_records(
    thread_id: &ThreadId,
    events: &[StoredEvent],
) -> Result<(), ThreadStoreError> {
    let mut previous_sequence: Option<u64> = None;
    for event in events {
        if &event.thread_id != thread_id || event.event.thread_id() != thread_id {
            return Err(ThreadStoreError::Storage(
                "Thread history contains an event for another Thread".into(),
            ));
        }
        if !supports_stored_event_schema_version(event.schema_version) {
            return Err(ThreadStoreError::Storage(
                "Thread history contains an unsupported event schema".into(),
            ));
        }
        let expected_sequence = match previous_sequence {
            None => 1,
            Some(previous) => previous.checked_add(1).ok_or_else(|| {
                ThreadStoreError::Storage("Thread history sequence overflowed".into())
            })?,
        };
        if event.sequence != expected_sequence {
            return Err(ThreadStoreError::Storage(
                "Thread history records are not contiguous and ordered".into(),
            ));
        }
        previous_sequence = Some(event.sequence);
    }
    Ok(())
}

fn storage_error(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(sql_error(error))
}
