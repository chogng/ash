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
/// Version 23 uses manual/auto permission IDs. Older records retain their hashed byte representation.
pub const CURRENT_STORED_EVENT_SCHEMA_VERSION: u32 = 24;

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
            record.serialize_field(
                "command",
                &StoredCommandReceipt(command, self.schema_version),
            )?;
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
        // Old imported Turns must retain their byte representation: history prefixes are
        // addressed by a digest of their serialized records, not just their reduced state.
        if self.0.schema_version < 23 {
            match &self.0.event {
                ThreadEvent::TurnAccepted {
                    thread_id,
                    turn_id,
                    kind,
                    mode,
                    instructions,
                    policy_revision,
                    approval_mode,
                    tool_mode,
                    activated_skills,
                    model,
                    reasoning_effort,
                    advisor,
                    tool_profile,
                } => {
                    let mut event = serializer.serialize_struct("TurnAccepted", 15)?;
                    event.serialize_field("type", "turnAccepted")?;
                    event.serialize_field("threadId", thread_id)?;
                    event.serialize_field("turnId", turn_id)?;
                    event.serialize_field("kind", kind)?;
                    if !mode.is_agent() {
                        event.serialize_field("mode", mode)?;
                    }
                    if let Some(value) = instructions {
                        event.serialize_field("instructions", value)?;
                    }
                    event.serialize_field("policyRevision", policy_revision)?;
                    event.serialize_field(
                        "approvalMode",
                        &StoredApprovalMode(*approval_mode, self.0.schema_version),
                    )?;
                    event.serialize_field("toolMode", tool_mode)?;
                    event.serialize_field("activatedSkills", activated_skills)?;
                    if let Some(value) = model {
                        event.serialize_field("model", value)?;
                    }
                    if let Some(value) = reasoning_effort {
                        event.serialize_field("reasoningEffort", value)?;
                    }
                    if let Some(value) = advisor {
                        event.serialize_field("advisor", value)?;
                    }
                    if let Some(value) = tool_profile {
                        event.serialize_field("toolProfile", value)?;
                    }
                    return event.end();
                }
                ThreadEvent::HistoryImported {
                    thread_id,
                    source_thread_id,
                    before_turn_id,
                    turns,
                } => {
                    let mut event = serializer.serialize_struct("HistoryImported", 5)?;
                    event.serialize_field("type", "historyImported")?;
                    event.serialize_field("threadId", thread_id)?;
                    event.serialize_field("sourceThreadId", source_thread_id)?;
                    event.serialize_field("beforeTurnId", before_turn_id)?;
                    event.serialize_field("turns", &LegacyTurns(turns, self.0.schema_version))?;
                    return event.end();
                }
                ThreadEvent::ForkHistoryImported {
                    thread_id,
                    source_thread_id,
                    source_sequence,
                    turns,
                } => {
                    let mut event = serializer.serialize_struct("ForkHistoryImported", 5)?;
                    event.serialize_field("type", "forkHistoryImported")?;
                    event.serialize_field("threadId", thread_id)?;
                    event.serialize_field("sourceThreadId", source_thread_id)?;
                    event.serialize_field("sourceSequence", source_sequence)?;
                    event.serialize_field("turns", &LegacyTurns(turns, self.0.schema_version))?;
                    return event.end();
                }
                ThreadEvent::ForkTurnImported {
                    thread_id,
                    source_thread_id,
                    source_sequence,
                    turn_index,
                    turn,
                } => {
                    let mut event = serializer.serialize_struct("ForkTurnImported", 6)?;
                    event.serialize_field("type", "forkTurnImported")?;
                    event.serialize_field("threadId", thread_id)?;
                    event.serialize_field("sourceThreadId", source_thread_id)?;
                    event.serialize_field("sourceSequence", source_sequence)?;
                    event.serialize_field("turnIndex", turn_index)?;
                    event.serialize_field("turn", &LegacyTurn(turn, self.0.schema_version))?;
                    return event.end();
                }
                _ => {}
            }
        }
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

// Stored history retains its original schema because prefix IDs hash its serialized bytes.
struct LegacyTurn<'a>(&'a ash_protocol::Turn, u32);

impl Serialize for LegacyTurn<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let turn = self.0;
        let mut record = serializer.serialize_struct("Turn", 17)?;
        record.serialize_field("turnId", &turn.turn_id)?;
        record.serialize_field("status", &turn.status)?;
        record.serialize_field("kind", &turn.kind)?;
        if self.1 >= 22 {
            record.serialize_field("mode", &turn.mode)?;
        }
        macro_rules! optional {
            ($name:literal, $value:expr) => {
                if let Some(value) = $value {
                    record.serialize_field($name, value)?;
                }
            };
        }
        optional!("instructions", &turn.instructions);
        optional!("model", &turn.model);
        optional!("reasoningEffort", &turn.reasoning_effort);
        optional!("advisor", &turn.advisor);
        optional!("toolProfile", &turn.tool_profile);
        record.serialize_field("toolMode", &turn.tool_mode)?;
        record.serialize_field(
            "approvalMode",
            &StoredApprovalMode(turn.approval_mode, self.1),
        )?;
        record.serialize_field("usage", &turn.usage)?;
        optional!("contextUsage", &turn.context_usage);
        record.serialize_field("items", &turn.items)?;
        optional!("plan", &turn.plan);
        optional!("pendingInteraction", &turn.pending_interaction);
        optional!("error", &turn.error);
        record.end()
    }
}

struct LegacyTurns<'a>(&'a [ash_protocol::Turn], u32);
impl Serialize for LegacyTurns<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut turns = serializer.serialize_seq(Some(self.0.len()))?;
        for turn in self.0 {
            turns.serialize_element(&LegacyTurn(turn, self.1))?;
        }
        turns.end()
    }
}

struct StoredApprovalMode(ash_protocol::ApprovalMode, u32);

impl Serialize for StoredApprovalMode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.1 >= 23 {
            return self.0.serialize(serializer);
        }
        serializer.serialize_str(match self.0 {
            ash_protocol::ApprovalMode::Manual => "askPermissions",
            ash_protocol::ApprovalMode::Auto => "autoReview",
            ash_protocol::ApprovalMode::BypassPermissions => "bypassPermissions",
        })
    }
}

struct StoredCommandReceipt<'a>(&'a ThreadCommandReceipt, u32);

impl Serialize for StoredCommandReceipt<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut receipt = serializer.serialize_struct("ThreadCommandReceipt", 2)?;
        receipt.serialize_field("commandId", &self.0.command_id)?;
        receipt.serialize_field("command", &StoredThreadCommand(&self.0.command, self.1))?;
        receipt.end()
    }
}

struct StoredThreadCommand<'a>(&'a ThreadCommand, u32);

impl Serialize for StoredThreadCommand<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.1 >= 23 {
            return self.0.serialize(serializer);
        }
        match self.0 {
            ThreadCommand::StartTurn {
                context_policy: _,
                kind,
                mode,
                instructions,
                model,
                reasoning_effort,
                advisor,
                activated_skills,
                host_activated_skills,
                approval_mode,
                tool_mode,
                tool_profile,
                input,
            } => {
                let mut command = serializer.serialize_struct("StartTurn", 13)?;
                command.serialize_field("type", "startTurn")?;
                command.serialize_field("kind", kind)?;
                if !mode.is_agent() {
                    command.serialize_field("mode", mode)?;
                }
                if let Some(value) = instructions {
                    command.serialize_field("instructions", value)?;
                }
                if let Some(value) = model {
                    command.serialize_field("model", value)?;
                }
                if let Some(value) = reasoning_effort {
                    command.serialize_field("reasoningEffort", value)?;
                }
                if let Some(value) = advisor {
                    command.serialize_field("advisor", value)?;
                }
                command.serialize_field("activatedSkills", activated_skills)?;
                if let Some(value) = host_activated_skills {
                    command.serialize_field("hostActivatedSkills", value)?;
                }
                command
                    .serialize_field("approvalMode", &StoredApprovalMode(*approval_mode, self.1))?;
                command.serialize_field("toolMode", tool_mode)?;
                if let Some(value) = tool_profile {
                    command.serialize_field("toolProfile", value)?;
                }
                command.serialize_field("input", input)?;
                command.end()
            }
            ThreadCommand::StartShellTurn {
                command,
                approval_mode,
            } => {
                let mut value = serializer.serialize_struct("StartShellTurn", 3)?;
                value.serialize_field("type", "startShellTurn")?;
                value.serialize_field("command", command)?;
                value
                    .serialize_field("approvalMode", &StoredApprovalMode(*approval_mode, self.1))?;
                value.end()
            }
            _ => self.0.serialize(serializer),
        }
    }
}

fn migrate_approval_field(value: &mut serde_json::Value) {
    if let Some(approval) = value.get_mut("approvalMode") {
        let current = match approval.as_str() {
            Some("askPermissions") => Some("manual"),
            Some("autoReview") => Some("auto"),
            _ => None,
        };
        if let Some(current) = current {
            *approval = current.into();
        }
    }
}

fn migrate_event_approval(event: &mut serde_json::Value) {
    match event.get("type").and_then(serde_json::Value::as_str) {
        Some("turnAccepted") => migrate_approval_field(event),
        Some("historyImported" | "forkHistoryImported") => {
            if let Some(turns) = event
                .get_mut("turns")
                .and_then(serde_json::Value::as_array_mut)
            {
                for turn in turns {
                    migrate_approval_field(turn);
                }
            }
        }
        Some("forkTurnImported") => {
            if let Some(turn) = event.get_mut("turn") {
                migrate_approval_field(turn);
            }
        }
        _ => {}
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
            command: Option<serde_json::Value>,
            event: serde_json::Value,
        }

        let mut record = Record::deserialize(deserializer)?;
        if record.schema_version < 23 {
            migrate_event_approval(&mut record.event);
            if let Some(command) = record
                .command
                .as_mut()
                .and_then(|receipt| receipt.get_mut("command"))
            {
                migrate_approval_field(command);
            }
        }
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
            command: record
                .command
                .map(serde_json::from_value)
                .transpose()
                .map_err(D::Error::custom)?,
            event: serde_json::from_value(record.event).map_err(D::Error::custom)?,
        })
    }
}

impl StoredEvent {
    pub fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }
}
