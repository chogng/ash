use ash_protocol::CommandId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use serde::de::Error;
use serde::ser::SerializeStruct;

/// Schema version written for newly persisted Thread history records.
/// Version 21 names the Session execution target independently of the frontend Workspace.
pub const CURRENT_STORED_EVENT_SCHEMA_VERSION: u32 = 21;

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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredEvent {
    /// Present for user-message facts captured with an enabled time-context policy.
    pub time_context: Option<ash_protocol::TimeContext>,
    pub schema_version: u32,
    pub event_id: EventId,
    pub sequence: u64,
    pub thread_id: ThreadId,
    pub recorded_at: Timestamp,
    pub command: Option<ThreadCommandReceipt>,
    pub event: ThreadEvent,
}

impl Serialize for StoredEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut record = serializer.serialize_struct("StoredEvent", 8)?;
        if let Some(time_context) = &self.time_context {
            record.serialize_field("timeContext", time_context)?;
        }
        record.serialize_field("schemaVersion", &self.schema_version)?;
        record.serialize_field("eventId", &self.event_id)?;
        record.serialize_field("sequence", &self.sequence)?;
        record.serialize_field("threadId", &self.thread_id)?;
        record.serialize_field("recordedAt", &self.recorded_at)?;
        if let Some(command) = &self.command {
            record.serialize_field("command", command)?;
        }
        record.serialize_field("event", &StoredThreadEvent(self))?;
        record.end()
    }
}

struct StoredThreadEvent<'a>(&'a StoredEvent);

impl Serialize for StoredThreadEvent<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.0.schema_version >= 21 {
            return self.0.event.serialize(serializer);
        }
        let ThreadEvent::ThreadCreated {
            agent_id,
            origin,
            agent,
            session_id,
            thread_id,
            title,
            execution_target,
        } = &self.0.event
        else {
            return self.0.event.serialize(serializer);
        };
        let mut event = serializer.serialize_struct("ThreadCreated", 8)?;
        event.serialize_field("type", "threadCreated")?;
        if let Some(agent_id) = agent_id {
            event.serialize_field("agentId", agent_id)?;
        }
        if !origin.is_root() {
            event.serialize_field("origin", origin)?;
        }
        if let Some(agent) = agent {
            event.serialize_field("agent", agent)?;
        }
        event.serialize_field("sessionId", session_id)?;
        event.serialize_field("threadId", thread_id)?;
        event.serialize_field("title", title)?;
        if let Some(target) = execution_target {
            event.serialize_field("workspace", target)?;
        }
        event.end()
    }
}

impl<'de> Deserialize<'de> for StoredEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Record {
            #[serde(default)]
            time_context: Option<ash_protocol::TimeContext>,
            schema_version: u32,
            event_id: EventId,
            sequence: u64,
            thread_id: ThreadId,
            recorded_at: Timestamp,
            #[serde(default)]
            command: Option<ThreadCommandReceipt>,
            event: serde_json::Value,
        }

        let mut record = Record::deserialize(deserializer)?;
        if record.schema_version < 21
            && record.event.get("type").and_then(serde_json::Value::as_str) == Some("threadCreated")
        {
            let fields = record
                .event
                .as_object_mut()
                .ok_or_else(|| D::Error::custom("Thread creation event must be an object"))?;
            if let Some(target) = fields.remove("workspace") {
                if fields.insert("executionTarget".into(), target).is_some() {
                    return Err(D::Error::custom(
                        "Thread creation has two execution targets",
                    ));
                }
            }
        }
        Ok(Self {
            time_context: record.time_context,
            schema_version: record.schema_version,
            event_id: record.event_id,
            sequence: record.sequence,
            thread_id: record.thread_id,
            recorded_at: record.recorded_at,
            command: record.command,
            event: serde_json::from_value(record.event).map_err(D::Error::custom)?,
        })
    }
}

impl StoredEvent {
    pub fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }
}
