use super::thread::SqliteThreadStore;
use agent_graph_store::AgentGraphStore;
use agent_graph_store::AgentGraphStoreError;
use agent_graph_store::AgentRecord;
use agent_graph_store::ThreadBinding;
use ash_protocol::AgentId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_thread_store::ThreadCatalogRecord;
use ash_thread_store::ThreadStoreError;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

impl AgentGraphStore for SqliteThreadStore {
    fn read_agent(&self, agent_id: &AgentId) -> Result<Option<AgentRecord>, AgentGraphStoreError> {
        let created_at = self
            .connection()
            .map_err(graph_error)?
            .query_row(
                "SELECT created_at_unix_ms FROM agents WHERE agent_id = ?1",
                [agent_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(graph_error)?;
        created_at
            .map(|created_at| {
                Ok(AgentRecord {
                    agent_id: agent_id.clone(),
                    created_at_unix_ms: u64::try_from(created_at).map_err(graph_error)?,
                })
            })
            .transpose()
    }

    fn read_thread_binding(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<ThreadBinding>, AgentGraphStoreError> {
        binding(&*self.connection().map_err(graph_error)?, thread_id).map_err(graph_error)
    }

    fn list_agent_threads(
        &self,
        agent_id: &AgentId,
    ) -> Result<Vec<ThreadBinding>, AgentGraphStoreError> {
        let connection = self.connection().map_err(graph_error)?;
        let mut statement = connection
            .prepare(
                "SELECT binding_json FROM agent_threads WHERE agent_id = ?1 ORDER BY thread_id",
            )
            .map_err(graph_error)?;
        statement
            .query_map([agent_id.as_str()], |row| row.get::<_, String>(0))
            .map_err(graph_error)?
            .map(|row| serde_json::from_str(&row.map_err(graph_error)?).map_err(graph_error))
            .collect()
    }

    fn list_spawn_children(
        &self,
        parent_thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, AgentGraphStoreError> {
        query_ids(
            &*self.connection().map_err(graph_error)?,
            "SELECT thread_id FROM agent_threads WHERE spawn_parent_id = ?1 ORDER BY thread_id",
            parent_thread_id,
        )
    }

    fn list_spawn_descendants(
        &self,
        root_thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, AgentGraphStoreError> {
        query_ids(&*self.connection().map_err(graph_error)?,
            "WITH RECURSIVE descendants(thread_id, depth, path) AS (
                 SELECT thread_id, 1, json_array(?1, thread_id) FROM agent_threads
                 WHERE spawn_parent_id = ?1 AND thread_id != ?1
                 UNION ALL
                 SELECT child.thread_id, parent.depth + 1, json_insert(parent.path, '$[#]', child.thread_id)
                 FROM agent_threads child JOIN descendants parent ON child.spawn_parent_id = parent.thread_id
                 WHERE NOT EXISTS (SELECT 1 FROM json_each(parent.path) WHERE value = child.thread_id)
             ) SELECT thread_id FROM descendants GROUP BY thread_id ORDER BY MIN(depth), thread_id", root_thread_id)
    }
}

fn query_ids(
    connection: &Connection,
    sql: &str,
    thread_id: &ThreadId,
) -> Result<Vec<ThreadId>, AgentGraphStoreError> {
    let mut statement = connection.prepare(sql).map_err(graph_error)?;
    statement
        .query_map([thread_id.as_str()], |row| row.get::<_, String>(0))
        .map_err(graph_error)?
        .map(|row| ThreadId::new(row.map_err(graph_error)?).map_err(graph_error))
        .collect()
}

fn binding(
    connection: &Connection,
    thread_id: &ThreadId,
) -> Result<Option<ThreadBinding>, ThreadStoreError> {
    connection
        .query_row(
            "SELECT binding_json FROM agent_threads WHERE thread_id = ?1",
            [thread_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)?
        .map(|json| serde_json::from_str(&json).map_err(storage_error))
        .transpose()
}

/// Called within the Thread append transaction before any binding becomes visible.
pub(super) fn write_binding(
    connection: &Connection,
    record: &ThreadCatalogRecord,
) -> Result<(), ThreadStoreError> {
    if let Some(existing) = binding(connection, &record.binding.thread_id)? {
        if existing != record.binding {
            return Err(ThreadStoreError::InvalidBatch(
                "Thread Agent identity and origin are immutable".into(),
            ));
        }
        return Ok(());
    }
    if let Some(source) = record.binding.source_thread_id() {
        let json = connection
            .query_row(
                "SELECT record_json FROM thread_catalog WHERE thread_id = ?1",
                [source.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| ThreadStoreError::InvalidBatch("Thread origin does not exist".into()))?;
        let source: ThreadCatalogRecord = serde_json::from_str(&json).map_err(storage_error)?;
        ash_thread_store::validate_binding_source(record, &source)?;
    }
    install_binding(
        connection,
        &record.binding,
        record.thread.created_at_unix_ms,
    )
}

/// Installs already validated bindings, including schema migration of legacy history.
pub(super) fn install_binding(
    connection: &Connection,
    record: &ThreadBinding,
    created_at: u64,
) -> Result<(), ThreadStoreError> {
    connection
        .execute(
            "INSERT OR IGNORE INTO agents (agent_id, created_at_unix_ms) VALUES (?1, ?2)",
            params![
                record.agent_id.as_str(),
                i64::try_from(created_at).map_err(storage_error)?
            ],
        )
        .map_err(storage_error)?;
    let replacement = match &record.origin {
        ThreadOrigin::Replacement {
            source_thread_id, ..
        } => Some(source_thread_id.as_str()),
        _ => None,
    };
    connection.execute(
        "INSERT INTO agent_threads (thread_id, agent_id, session_id, spawn_parent_id, replacement_source_id, binding_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![record.thread_id.as_str(), record.agent_id.as_str(), record.session_id.as_str(),
            record.spawn_parent().map(ThreadId::as_str), replacement, serde_json::to_string(record).map_err(storage_error)?],
    ).map_err(storage_error)?;
    Ok(())
}

fn graph_error(error: impl std::fmt::Display) -> AgentGraphStoreError {
    AgentGraphStoreError(error.to_string())
}

fn storage_error(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(error.to_string())
}

/// One-way migration: preserve immutable event bytes while recording legacy identities and
/// provenance once in the new index. Missing catalogs are rebuilt by the owning Core reducer.
pub(super) fn migrate_bindings(connection: &Connection) -> Result<(), ThreadStoreError> {
    let ids = {
        let mut statement = connection.prepare("SELECT thread_id FROM thread_streams WHERE current_sequence > 0 ORDER BY thread_id").map_err(storage_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?
    };
    for id in ids {
        let events = {
            let mut statement = connection.prepare("SELECT envelope_json FROM thread_events WHERE thread_id = ?1 ORDER BY sequence").map_err(storage_error)?;
            statement
                .query_map([&id], |row| row.get::<_, String>(0))
                .map_err(storage_error)?
                .map(|row| {
                    serde_json::from_str::<ash_history::StoredEvent>(&row.map_err(storage_error)?)
                        .map_err(storage_error)
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let first = events.first().ok_or_else(|| {
            ThreadStoreError::Storage("Thread stream has no creation event".into())
        })?;
        let ash_protocol::ThreadEvent::ThreadCreated {
            session_id,
            thread_id,
            origin,
            ..
        } = &first.event
        else {
            return Err(ThreadStoreError::Storage(
                "Thread history must start with creation".into(),
            ));
        };
        let mut origin = origin.clone();
        for event in &events {
            if event.schema_version < 16 {
                if let Some(recorded) = ash_history::inherited_thread_origin(&event.event) {
                    origin = recorded;
                }
            }
        }
        let record = ThreadBinding {
            agent_id: ash_history::created_thread_agent_id(first).map_err(storage_error)?,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            origin,
        };
        install_binding(
            connection,
            &record,
            u64::try_from(first.recorded_at.0).map_err(storage_error)?,
        )?;
        if let Some(json) = connection
            .query_row(
                "SELECT record_json FROM thread_catalog WHERE thread_id = ?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage_error)?
        {
            let mut catalog: serde_json::Value =
                serde_json::from_str(&json).map_err(storage_error)?;
            catalog["binding"] = serde_json::to_value(&record).map_err(storage_error)?;
            connection
                .execute(
                    "UPDATE thread_catalog SET record_json = ?1 WHERE thread_id = ?2",
                    params![serde_json::to_string(&catalog).map_err(storage_error)?, id],
                )
                .map_err(storage_error)?;
        }
    }
    Ok(())
}
