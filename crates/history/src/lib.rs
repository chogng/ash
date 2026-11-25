//! Model-history and persisted Thread-record domain types.
//!
//! This crate defines the data that survives process restarts. It deliberately owns no database,
//! filesystem, pagination, append transaction, or reducer implementation.

mod context_seed;
mod prefix;
mod record;
mod retired_fields;
pub use context_seed::context_seed_digest;
pub use prefix::HistoryPrefix;
pub use retired_fields::discard_retired_agent_fields;
pub use retired_fields::discard_retired_turn_fields;

/// Reachability roots for file snapshots embedded in immutable history records.
pub fn repository_checkpoints(
    event: &ash_protocol::ThreadEvent,
) -> Vec<&ash_protocol::RepositoryCheckpoint> {
    let workspaces = match event {
        ash_protocol::ThreadEvent::ItemCompleted {
            workspace_checkpoint,
            ..
        } => workspace_checkpoint.iter().collect(),
        ash_protocol::ThreadEvent::ThreadCreated {
            origin: ash_protocol::ThreadOrigin::Message { workspace, .. },
            ..
        } => vec![workspace],
        ash_protocol::ThreadEvent::ThreadHistoryMoved {
            target, previous, ..
        } => vec![&target.workspace, &previous.workspace],
        _ => Vec::new(),
    };
    workspaces
        .into_iter()
        .flat_map(|workspace| match workspace {
            ash_protocol::WorkspaceCheckpoint::Git { repositories, .. } => repositories.as_slice(),
            ash_protocol::WorkspaceCheckpoint::NoFiles
            | ash_protocol::WorkspaceCheckpoint::Directory { .. }
            | ash_protocol::WorkspaceCheckpoint::Unavailable { .. } => &[],
        })
        .collect()
}

pub use record::created_thread_agent_id;
pub use record::inherited_thread_origin;

pub use record::CURRENT_STORED_EVENT_SCHEMA_VERSION;
pub use record::EventId;
pub use record::MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION;
pub use record::StoredEvent;
pub use record::StoredEventEncoding;
pub use record::ThreadCommandReceipt;
pub use record::ThreadCreatedKindEncoding;
pub use record::Timestamp;
pub use record::supports_stored_event_schema_version;

#[cfg(test)]
#[path = "record_tests.rs"]
mod tests;
