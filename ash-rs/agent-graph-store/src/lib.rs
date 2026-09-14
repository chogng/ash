//! Persistent Agent identities and read-only Thread relationship queries.

use serde::Deserialize;
use serde::Serialize;
use ash_protocol::AgentId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;

/// Durable identity that survives replacement or deletion of its execution branches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub agent_id: AgentId,
    pub created_at_unix_ms: u64,
}

/// Immutable identity and provenance of one execution branch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBinding {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub origin: ThreadOrigin,
}

impl ThreadBinding {
    pub fn source_thread_id(&self) -> Option<&ThreadId> {
        match &self.origin {
            ThreadOrigin::Root => None,
            ThreadOrigin::Fork {
                parent_thread_id, ..
            }
            | ThreadOrigin::Message {
                parent_thread_id, ..
            }
            | ThreadOrigin::Rewind {
                parent_thread_id, ..
            }
            | ThreadOrigin::AgentSpawn {
                parent_thread_id, ..
            } => Some(parent_thread_id),
            ThreadOrigin::Replacement {
                source_thread_id, ..
            } => Some(source_thread_id),
        }
    }

    pub fn spawn_parent(&self) -> Option<&ThreadId> {
        match &self.origin {
            ThreadOrigin::AgentSpawn {
                parent_thread_id, ..
            } => Some(parent_thread_id),
            _ => None,
        }
    }

    /// Checks the immutable relationship against its already committed source branch.
    pub fn validate_source(&self, source: &Self) -> Result<(), AgentGraphStoreError> {
        if self.source_thread_id() != Some(&source.thread_id)
            || self.thread_id == source.thread_id
            || (self.session_id != source.session_id
                && !(matches!(self.origin, ThreadOrigin::Fork { .. })
                    && self.thread_id.as_str() == self.session_id.as_str()))
        {
            return Err(AgentGraphStoreError(
                "Thread origin must refer to another branch; only a fork may create a Session root".into(),
            ));
        }
        if self.spawn_parent().is_none() && self.agent_id != source.agent_id {
            return Err(AgentGraphStoreError(
                "fork, rewind and replacement must preserve Agent identity".into(),
            ));
        }
        Ok(())
    }
}

/// Failure to read persisted identities or relationships.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentGraphStoreError(pub String);

impl std::fmt::Display for AgentGraphStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AgentGraphStoreError {}

/// Reads identities and immutable relationships without loading Thread histories.
///
/// Implementations commit bindings with the creating Thread's event batch. No independent
/// mutation may reassign a Thread's Agent or parent. Agent records survive Thread deletion.
/// Lists are ordered by Thread ID; descendant lists use breadth-first depth then Thread ID and
/// traverse only AgentSpawn edges, excluding fork, rewind and replacement relationships.
pub trait AgentGraphStore: Send + Sync {
    fn read_agent(&self, agent_id: &AgentId) -> Result<Option<AgentRecord>, AgentGraphStoreError>;

    fn read_thread_binding(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<ThreadBinding>, AgentGraphStoreError>;

    fn list_agent_threads(
        &self,
        agent_id: &AgentId,
    ) -> Result<Vec<ThreadBinding>, AgentGraphStoreError>;

    fn list_spawn_children(
        &self,
        parent_thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, AgentGraphStoreError>;

    fn list_spawn_descendants(
        &self,
        root_thread_id: &ThreadId,
    ) -> Result<Vec<ThreadId>, AgentGraphStoreError>;
}
