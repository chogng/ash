use ash_protocol::CommandId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

/// Schema version written for newly persisted Thread history records.
/// Version 19 adds Advisor selection, frozen Turn configuration and tool-linked model accounting.
pub const CURRENT_STORED_EVENT_SCHEMA_VERSION: u32 = 19;

/// Resolves the identity at the history-version boundary. Legacy branches each receive one
/// deterministic identity; current records must carry their explicitly allocated identity.
pub fn created_thread_agent_id(record: &StoredEvent) -> Result<ash_protocol::AgentId, String> {
    if !supports_stored_event_schema_version(record.schema_version) {
        return Err("unsupported Thread history schema".into());
    }
    let ThreadEvent::ThreadCreated {
        agent_id,
        thread_id,
        ..
    } = &record.event
    else {
        return Err("first Thread event must create its Thread".into());
    };
    if let Some(agent_id) = agent_id {
        return Ok(agent_id.clone());
    }
    if record.schema_version < 16 {
        return ash_protocol::AgentId::new(format!("legacy-agent:{thread_id}"))
            .map_err(|error| error.to_string());
    }
    Err("Thread creation must record its Agent identity".into())
}

/// Reads exact provenance anchors from inherited-history and delegation facts.
pub fn inherited_thread_origin(event: &ThreadEvent) -> Option<ash_protocol::ThreadOrigin> {
    use ash_protocol::ThreadOrigin;
    match event {
        ThreadEvent::AgentContextSeedCommitted { seed, .. } => Some(ThreadOrigin::AgentSpawn {
            parent_thread_id: seed.parent_thread_id.clone(),
            parent_sequence: seed.parent_sequence,
            delegation_id: seed.delegation_id.clone(),
        }),
        ThreadEvent::HistoryImported {
            source_thread_id,
            before_turn_id,
            ..
        } => Some(ThreadOrigin::Rewind {
            parent_thread_id: source_thread_id.clone(),
            before_turn_id: before_turn_id.clone(),
        }),
        ThreadEvent::ForkHistoryImported {
            source_thread_id,
            source_sequence,
            ..
        }
        | ThreadEvent::ForkHistoryImportCompleted {
            source_thread_id,
            source_sequence,
            ..
        } => Some(ThreadOrigin::Fork {
            parent_thread_id: source_thread_id.clone(),
            parent_sequence: *source_sequence,
        }),
        _ => None,
    }
}

/// Oldest Thread history record schema accepted during recovery.
pub const MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION: u32 = 12;

/// Returns whether a persisted Thread history record can be replayed by this build.
pub const fn supports_stored_event_schema_version(schema_version: u32) -> bool {
    schema_version >= MINIMUM_SUPPORTED_EVENT_SCHEMA_VERSION
        && schema_version <= CURRENT_STORED_EVENT_SCHEMA_VERSION
}

/// Stable identity of one persisted Thread history record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EventId(pub String);

/// Unix timestamp in milliseconds attached to a persisted Thread history record.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Timestamp(pub u128);

/// The exact typed command durably accepted by a Thread stream.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCommandReceipt {
    pub command_id: CommandId,
    pub command: ThreadCommand,
}

/// Canonical persisted envelope for one durable Thread fact.
///
/// Only durable [`ThreadEvent`] values can enter this envelope. Core constructs the record when a
/// command is accepted; a Thread Store validates and persists the exact value. Live updates, token
/// deltas, storage transactions, and query cursors do not belong to this data contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    /// Present for user-message facts captured with an enabled time-context policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_context: Option<ash_protocol::TimeContext>,
    pub schema_version: u32,
    pub event_id: EventId,
    pub sequence: u64,
    pub thread_id: ThreadId,
    pub recorded_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<ThreadCommandReceipt>,
    pub event: ThreadEvent,
}

impl StoredEvent {
    pub fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }
}
