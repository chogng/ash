use crate::JsonSchema;
use crate::TS;
use crate::protocol::common::CommandId;
use crate::protocol::common::RequestId;
use crate::protocol::common::SessionId;
use crate::protocol::common::ThreadId;
use crate::protocol::common::TurnId;
use crate::protocol::turn::InputItem;
use crate::protocol::turn::TurnInteractionResolveResult;
use crate::protocol::turn::TurnInterruptResult;
use crate::protocol::turn::TurnStartResult;
use ash_protocol::AgentResponse;
use ash_protocol::AgentTreeProjection;
use ash_protocol::ReviewTarget;
use ash_protocol::Session;
use ash_protocol::Thread;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolMode;
use ash_thread_transcript::ThreadTranscriptSnapshot;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    /// Reuse an existing Agent identity in a new task; omission allocates a new identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub agent_id: Option<ash_protocol::AgentId>,
    #[serde(default)]
    pub agent: ash_protocol::AgentRoleSelection,
    pub command_id: CommandId,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionReadParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogReadResult {
    pub session: Option<Session>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubscribeParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionUnsubscribeParams {
    pub session_id: SessionId,
}

/// Non-durable invalidation for a Session tree derived from Thread state.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanged {
    pub session_id: SessionId,
    pub agent_tree_changed: bool,
}

/// Notification that one Session and all of its Threads were permanently removed.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleted {
    pub session_id: SessionId,
}

/// A typed request routed through one `session_id` grouping boundary.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionRequest {
    Archive,
    Restore,
    Delete,
    Stop,
    CreateThread {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        agent_id: Option<ash_protocol::AgentId>,
        title: String,
    },
    ReplaceThread {
        source_thread_id: ThreadId,
        title: String,
    },
    RestoreMessage {
        thread_id: ThreadId,
        item_id: ash_protocol::ItemId,
        boundary: ash_protocol::MessageBoundary,
        title: String,
    },
    /// Copies the selected Thread history into an independent Session without subscribing to it.
    ForkSession {
        parent_thread_id: ThreadId,
        title: String,
    },
    ForkThread {
        parent_thread_id: ThreadId,
        title: String,
    },
    RewindThread {
        parent_thread_id: ThreadId,
        before_turn_id: TurnId,
        title: String,
    },
    RewriteThread {
        parent_thread_id: ThreadId,
        before_turn_id: TurnId,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        tool_mode: Option<ToolMode>,
        #[schemars(length(min = 1))]
        input: Vec<InputItem>,
    },
    StartTurn {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        #[serde(default)]
        approval_mode: ash_protocol::ApprovalMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        tool_mode: Option<ToolMode>,
        #[schemars(length(min = 1))]
        input: Vec<InputItem>,
    },
    StartReview {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        target: ReviewTarget,
    },
    StartShellTurn {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        #[serde(default)]
        approval_mode: ash_protocol::ApprovalMode,
        command: String,
        working_directory: String,
    },
    ConfigureAdvisor {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        selection: ash_protocol::AdvisorSelection,
    },
    ConsultAdvisor {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        question: String,
    },
    CompactContext {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        retention_prompt: Option<String>,
    },
    SteerTurn {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        turn_id: TurnId,
        #[schemars(length(min = 1))]
        input: Vec<InputItem>,
    },
    InterruptTurn {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        turn_id: TurnId,
    },
    ResolveInteraction {
        thread_id: ThreadId,
        #[ts(type = "number")]
        expected_sequence: u64,
        turn_id: TurnId,
        request_id: RequestId,
        response: AgentResponse,
    },
}

/// A request associated with one Session tree.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequestParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub request: SessionRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadReadParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<ThreadSnapshotHistory>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageCheckpointsParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageCheckpointsResult {
    pub checkpoints: Vec<ash_protocol::MessageCheckpoint>,
}

/// Maximum Turn count accepted by one bounded Thread snapshot request.
pub const MAX_THREAD_SNAPSHOT_TURNS: u32 = 100_000;

/// Selects how much durable Turn history is included in a Thread snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadSnapshotHistory {
    Latest {
        turn_limit: u32,
    },
    /// Selects a bounded page of Turns older than the supplied durable Turn identity.
    ///
    /// The returned Thread sequence still describes the aggregate at read time. It does not mean
    /// that the older page contains or confirms every Turn represented by that sequence.
    Before {
        turn_id: TurnId,
        turn_limit: u32,
    },
}

/// Describes whether a bounded Thread snapshot has older durable Turns available.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryBoundary {
    pub has_older_turns: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub oldest_turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadSubscribeParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[ts(type = "number")]
    pub after_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<ThreadSnapshotHistory>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadUnsubscribeParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionResult {
    pub session: Session,
    pub agent_tree: AgentTreeProjection,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionListResult {
    pub sessions: Vec<Session>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
/// A child Thread snapshot and its committed gap carried by the Session subscription.
pub struct SessionThreadProjection {
    pub thread: Thread,
    pub transcript: ThreadTranscriptSnapshot,
    pub updates: Vec<ThreadUpdateEnvelope>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
/// The Session tree view returned to product hosts.
pub struct SessionSubscribeResult {
    pub session: Session,
    pub thread_projections: Vec<SessionThreadProjection>,
    pub agent_tree: AgentTreeProjection,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadResult {
    pub session: Session,
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionRewriteResult {
    pub session: Session,
    pub thread_id: ThreadId,
    pub turn: TurnStartResult,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadReadResult {
    pub thread: Thread,
    pub transcript: ThreadTranscriptSnapshot,
    /// Present whenever the request selected bounded history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<ThreadHistoryBoundary>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionThreadSubscribeResult {
    pub thread: Thread,
    pub transcript: ThreadTranscriptSnapshot,
    pub updates: Vec<ThreadUpdateEnvelope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<ThreadHistoryBoundary>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorConfigureResult {
    #[ts(type = "number")]
    pub sequence: u64,
}

/// Typed result returned by the Session request endpoint.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum SessionRequestResult {
    Session(SessionResult),
    Deleted(SessionId),
    Thread(SessionThreadResult),
    Rewrite(SessionRewriteResult),
    Turn(TurnStartResult),
    TurnSteer(crate::protocol::turn::TurnSteerResult),
    TurnInterrupt(TurnInterruptResult),
    AdvisorConfigured(AdvisorConfigureResult),
    Interaction(TurnInteractionResolveResult),
}
