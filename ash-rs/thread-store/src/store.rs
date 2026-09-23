use crate::ThreadStoreError;
use ash_history::CURRENT_STORED_EVENT_SCHEMA_VERSION;
use ash_history::StoredEvent;
use ash_protocol::SessionId;
use ash_protocol::SessionManagerInfo;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

/// Lightweight durable facts used to list Sessions without replaying Thread history.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ThreadCatalogRecord {
    pub binding: agent_graph_store::ThreadBinding,
    pub session_id: SessionId,
    pub thread: SessionThread,
    pub sequence: u64,
    pub manager: SessionManagerInfo,
    pub archived_at_unix_ms: Option<u64>,
    pub stopped: bool,
    pub requires_startup_recovery: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadEventBatch {
    pub history_prefixes: Vec<ash_history::HistoryPrefix>,
    pub batch_id: String,
    pub thread_id: ThreadId,
    pub expected_sequence: u64,
    pub events: Vec<StoredEvent>,
    pub catalog: ThreadCatalogRecord,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendBatchResult {
    pub batch_id: String,
    pub committed_sequence: u64,
    pub event_count: usize,
}

/// Loads and atomically extends the authoritative event history for one Thread.
///
/// Implementations must reject stale `expected_sequence` values. `append_batch` commits every
/// event or none, makes the complete batch durable before returning success, and excludes
/// uncommitted tail batches from subsequent `load` results.
pub trait ThreadStore: agent_graph_store::AgentGraphStore {
    fn list_thread_ids(&self) -> Result<Vec<ThreadId>, ThreadStoreError>;

    /// Reads one Session's membership through its durable index, without replaying histories.
    fn list_session_thread_ids(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadId>, ThreadStoreError>;

    fn list_catalog(&self) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError>;

    /// Reads the catalog rows for one Session through the Session index.
    fn session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ThreadCatalogRecord>, ThreadStoreError>;

    /// Installs a missing or damaged catalog row from the authoritative Thread history.
    fn backfill_catalog(&self, record: &ThreadCatalogRecord) -> Result<(), ThreadStoreError>;

    /// Permanently removes every durable Thread owned by one Session.
    ///
    /// Implementations must delete the catalog, event history, and related per-Thread state in
    /// one atomic commit. The returned IDs are the Threads that were removed.
    fn delete_session(&self, session_id: &SessionId) -> Result<Vec<ThreadId>, ThreadStoreError>;

    fn load(&self, thread_id: &ThreadId) -> Result<Vec<StoredEvent>, ThreadStoreError>;

    /// Resolves and verifies a retained original prefix, including after source Thread deletion.
    fn load_history_prefix(
        &self,
        prefix: &ash_protocol::HistoryPrefixRef,
    ) -> Result<ash_history::HistoryPrefix, ThreadStoreError>;

    /// Durable cleanup work created only after the last retained history reference is removed.
    fn pending_checkpoint_cleanup(
        &self,
    ) -> Result<Vec<(String, ash_protocol::RepositoryCheckpoint)>, ThreadStoreError>;
    fn acknowledge_checkpoint_cleanup(&self, key: &str) -> Result<(), ThreadStoreError>;

    fn append_batch(&self, batch: &ThreadEventBatch)
    -> Result<AppendBatchResult, ThreadStoreError>;
}

pub fn validate_append_batch(
    batch: &ThreadEventBatch,
    actual_sequence: u64,
) -> Result<AppendBatchResult, ThreadStoreError> {
    if batch.expected_sequence != actual_sequence {
        return Err(ThreadStoreError::SequenceConflict {
            expected: batch.expected_sequence,
            actual: actual_sequence,
        });
    }
    if batch.batch_id.trim().is_empty() {
        return Err(ThreadStoreError::InvalidBatch(
            "batch ID must not be empty".into(),
        ));
    }
    if batch.events.is_empty() {
        return Err(ThreadStoreError::InvalidBatch(
            "batch must contain at least one event".into(),
        ));
    }
    for (index, event) in batch.events.iter().enumerate() {
        let sequence = batch.expected_sequence + index as u64 + 1;
        if event.schema_version != CURRENT_STORED_EVENT_SCHEMA_VERSION {
            return Err(ThreadStoreError::InvalidBatch(
                "new events must use the current schema version".into(),
            ));
        }
        if let ash_protocol::ThreadEvent::ThreadCreated {
            agent_id,
            origin,
            session_id,
            ..
        } = &event.event
        {
            if sequence != 1
                || agent_id.as_ref() != Some(&batch.catalog.binding.agent_id)
                || origin != &batch.catalog.binding.origin
                || session_id != &batch.catalog.session_id
            {
                return Err(ThreadStoreError::InvalidBatch(
                    "Thread creation and Agent binding disagree".into(),
                ));
            }
        }
        if let Some(origin) = ash_history::inherited_thread_origin(&event.event) {
            if origin != batch.catalog.binding.origin {
                return Err(ThreadStoreError::InvalidBatch(
                    "inherited context and Thread origin disagree".into(),
                ));
            }
        }
        if let ash_protocol::ThreadEvent::ItemCompleted {
            checkpoint_after_sequence: Some(after),
            ..
        } = &event.event
        {
            if *after < sequence
                || *after > batch.expected_sequence + batch.events.len() as u64
                || batch.events[index + 1..].iter().any(|next| {
                    next.sequence <= *after
                        && matches!(next.event, ash_protocol::ThreadEvent::ItemCompleted { .. })
                })
            {
                return Err(ThreadStoreError::InvalidBatch(
                    "message checkpoint crosses another message or its atomic commit".into(),
                ));
            }
        }
        if event.thread_id != batch.thread_id
            || event.event.thread_id() != &batch.thread_id
            || event.sequence != sequence
        {
            return Err(ThreadStoreError::InvalidBatch(
                "event Thread identity or sequence does not match its batch".into(),
            ));
        }
        if batch.events[..index]
            .iter()
            .any(|existing| existing.event_id == event.event_id)
        {
            return Err(ThreadStoreError::InvalidBatch(
                "event IDs must be unique within a batch".into(),
            ));
        }
    }
    if batch.catalog.thread.thread_id != batch.thread_id
        || batch.catalog.binding.thread_id != batch.thread_id
        || batch.catalog.binding.session_id != batch.catalog.session_id
        || batch.catalog.sequence != batch.expected_sequence + batch.events.len() as u64
    {
        return Err(ThreadStoreError::InvalidBatch(
            "catalog Thread identity or sequence does not match its batch".into(),
        ));
    }
    Ok(AppendBatchResult {
        batch_id: batch.batch_id.clone(),
        committed_sequence: batch.expected_sequence + batch.events.len() as u64,
        event_count: batch.events.len(),
    })
}

/// Validates a new branch against the source's committed catalog at the same storage boundary.
pub fn validate_binding_source(
    record: &ThreadCatalogRecord,
    source: &ThreadCatalogRecord,
) -> Result<(), ThreadStoreError> {
    record
        .binding
        .validate_source(&source.binding)
        .map_err(|error| ThreadStoreError::InvalidBatch(error.to_string()))?;
    let (sequence, replacement) = match &record.binding.origin {
        ash_protocol::ThreadOrigin::Root | ash_protocol::ThreadOrigin::Rewind { .. } => {
            return Ok(());
        }
        ash_protocol::ThreadOrigin::Fork {
            parent_sequence, ..
        }
        | ash_protocol::ThreadOrigin::Message {
            parent_sequence, ..
        }
        | ash_protocol::ThreadOrigin::AgentSpawn {
            parent_sequence, ..
        } => (*parent_sequence, false),
        ash_protocol::ThreadOrigin::Replacement {
            source_sequence, ..
        } => (*source_sequence, true),
    };
    if sequence == 0
        || sequence > source.sequence
        || (replacement
            && (sequence != source.sequence
                || source.thread.status != ash_protocol::ThreadStatus::Archived))
    {
        return Err(ThreadStoreError::InvalidBatch(
            "Thread source sequence or replacement state is invalid".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
