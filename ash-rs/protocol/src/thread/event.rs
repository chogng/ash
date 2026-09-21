use crate::AgentContextSeed;
use crate::AgentJoin;
use crate::AgentJoinId;
use crate::AgentMessage;
use crate::AgentResponse;
use crate::ApprovalMode;
use crate::CommandId;
use crate::ContextCheckpoint;
use crate::DelegationId;
use crate::DelegationResult;
use crate::FrozenSkillActivation;
use crate::InteractionCancelReason;
use crate::ItemId;
use crate::ModelInputEstimate;
use crate::ModelInvocationRecord;
use crate::ModelRef;
use crate::ModelUsage;
use crate::PlanUpdate;
use crate::RequestId;
use crate::SandboxDenialOutput;
use crate::SessionId;
use crate::StableTurnError;
use crate::ThreadArchiveReason;
use crate::ThreadId;
use crate::ThreadItem;
use crate::ToolCallId;
use crate::ToolMode;
use crate::ToolProfileSnapshot;
use crate::Turn;
use crate::TurnExecutionBinding;
use crate::TurnId;
use crate::TurnInstructions;
use crate::TurnInteraction;
use crate::TurnKind;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Durable authority selected before a Tool Call crosses its side-effect boundary.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolExecutionAuthority {
    Sandboxed,
    UnsandboxedGrant {
        grant_id: String,
    },
    ExecPolicyGranted {
        layer_id: String,
        rule_id: String,
        exec_policy_revision: String,
    },
    AutoReviewed {
        assessment_id: String,
    },
    PermissionBypassed,
    ApprovedOnce {
        request_id: RequestId,
    },
}

/// A durable fact in one Thread's authoritative event stream.
///
/// This enum deliberately excludes token deltas, delivery notifications, and client requests so
/// persistence adapters cannot accidentally append transient runtime messages.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadEvent {
    ThreadCreated {
        /// Absent only in history written before schema version 16.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        agent_id: Option<crate::AgentId>,
        #[serde(default, skip_serializing_if = "crate::ThreadOrigin::is_root")]
        origin: crate::ThreadOrigin,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        agent: Option<crate::AgentConfiguration>,
        session_id: SessionId,
        thread_id: ThreadId,
        title: String,
    },
    AdvisorConfigured {
        thread_id: ThreadId,
        selection: crate::AdvisorSelection,
    },
    ThreadArchived {
        thread_id: ThreadId,
        #[serde(default)]
        reason: ThreadArchiveReason,
    },
    ThreadRestored {
        thread_id: ThreadId,
    },
    /// Imports model-visible history from a retained original event prefix without copying it.
    HistoryPrefixBound {
        thread_id: ThreadId,
        prefix: crate::HistoryPrefixRef,
    },
    GoalCreated {
        thread_id: ThreadId,
        goal: crate::ThreadGoal,
    },
    GoalUpdated {
        thread_id: ThreadId,
        goal: crate::ThreadGoal,
    },
    GoalCleared {
        thread_id: ThreadId,
        goal_id: String,
    },
    /// Legacy read-compatibility fact from the removed external full-Turn backend integration.
    /// Current product code does not append this event.
    TurnExecutionBound {
        thread_id: ThreadId,
        binding: TurnExecutionBinding,
    },
    AgentContextSeedCommitted {
        thread_id: ThreadId,
        seed: Box<AgentContextSeed>,
    },
    HistoryImported {
        thread_id: ThreadId,
        source_thread_id: ThreadId,
        before_turn_id: TurnId,
        turns: Vec<Turn>,
    },
    /// Legacy read-compatibility fact written by history schema version 13.
    /// Current product code writes one `ForkTurnImported` per Turn followed by
    /// `ForkHistoryImportCompleted`.
    ForkHistoryImported {
        thread_id: ThreadId,
        source_thread_id: ThreadId,
        #[ts(type = "number")]
        source_sequence: u64,
        turns: Vec<Turn>,
    },
    ForkTurnImported {
        thread_id: ThreadId,
        source_thread_id: ThreadId,
        #[ts(type = "number")]
        source_sequence: u64,
        #[ts(type = "number")]
        turn_index: u64,
        turn: Box<Turn>,
    },
    ForkHistoryImportCompleted {
        thread_id: ThreadId,
        source_thread_id: ThreadId,
        #[ts(type = "number")]
        source_sequence: u64,
        #[ts(type = "number")]
        imported_turn_count: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        context_checkpoint: Option<ContextCheckpoint>,
    },
    ContextCheckpointCommitted {
        thread_id: ThreadId,
        checkpoint: ContextCheckpoint,
    },
    ContextOverflowRecoveryCommitted {
        thread_id: ThreadId,
        turn_id: TurnId,
        checkpoint: ContextCheckpoint,
    },
    TurnAccepted {
        thread_id: ThreadId,
        turn_id: TurnId,
        #[serde(default)]
        kind: TurnKind,
        /// Exact instructions selected before this Turn was durably accepted.
        ///
        /// Historical events written before instruction snapshots omit this field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        instructions: Option<TurnInstructions>,
        #[serde(default = "legacy_turn_action_policy_revision")]
        policy_revision: String,
        #[serde(default)]
        approval_mode: ApprovalMode,
        #[serde(default)]
        tool_mode: ToolMode,
        #[serde(default)]
        activated_skills: Vec<FrozenSkillActivation>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        model: Option<ModelRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        advisor: Option<crate::AdvisorConfig>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        tool_profile: Option<ToolProfileSnapshot>,
    },
    TurnStarted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    TurnSteered {
        thread_id: ThreadId,
        turn_id: TurnId,
        item_ids: Vec<ItemId>,
    },
    TurnSteerDelivered {
        thread_id: ThreadId,
        turn_id: TurnId,
        command_id: CommandId,
    },
    /// Legacy read-compatibility fact from the removed external full-Turn backend integration.
    /// Current product code does not append this event.
    TurnExecutionAttempted {
        thread_id: ThreadId,
        turn_id: TurnId,
        backend: String,
    },
    ModelUsageRecorded {
        thread_id: ThreadId,
        turn_id: TurnId,
        usage: Option<ModelUsage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        input_estimate: Option<ModelInputEstimate>,
    },
    ModelInvocationRecorded {
        thread_id: ThreadId,
        turn_id: TurnId,
        record: ModelInvocationRecord,
    },
    ItemCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable, type = "number")]
        checkpoint_after_sequence: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        workspace_checkpoint: Option<crate::WorkspaceCheckpoint>,
        thread_id: ThreadId,
        turn_id: TurnId,
        item: ThreadItem,
    },
    PlanUpdated {
        thread_id: ThreadId,
        turn_id: TurnId,
        plan: PlanUpdate,
    },
    InteractionRequested {
        thread_id: ThreadId,
        turn_id: TurnId,
        interaction: TurnInteraction,
    },
    InteractionResolved {
        thread_id: ThreadId,
        turn_id: TurnId,
        request_id: RequestId,
        response: AgentResponse,
    },
    ToolExecutionStarted {
        thread_id: ThreadId,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        action_digest: String,
        policy_revision: String,
        authority: ToolExecutionAuthority,
    },
    ToolExecutionEscalated {
        thread_id: ThreadId,
        turn_id: TurnId,
        tool_call_id: ToolCallId,
        action_digest: String,
        policy_revision: String,
        denial: SandboxDenialOutput,
        authority: ToolExecutionAuthority,
    },
    InteractionCancelled {
        thread_id: ThreadId,
        turn_id: TurnId,
        request_id: RequestId,
        reason: InteractionCancelReason,
    },
    TurnCompleted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    TurnFailed {
        thread_id: ThreadId,
        turn_id: TurnId,
        error: StableTurnError,
    },
    TurnCancelling {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    TurnInterrupted {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    DelegationRequested {
        thread_id: ThreadId,
        seed: Box<AgentContextSeed>,
    },
    DelegationStarted {
        thread_id: ThreadId,
        delegation_id: DelegationId,
        child_thread_id: ThreadId,
    },
    DelegationCancellationRequested {
        thread_id: ThreadId,
        delegation_id: DelegationId,
    },
    AgentCancellationReceived {
        thread_id: ThreadId,
        delegation_id: DelegationId,
        parent_thread_id: ThreadId,
    },
    DelegationResultProduced {
        thread_id: ThreadId,
        result: Box<DelegationResult>,
    },
    DelegationResultReceived {
        thread_id: ThreadId,
        result: Box<DelegationResult>,
    },
    AgentMessageSent {
        thread_id: ThreadId,
        message: Box<AgentMessage>,
    },
    AgentMessageReceived {
        thread_id: ThreadId,
        message: Box<AgentMessage>,
    },
    AgentJoinRequested {
        thread_id: ThreadId,
        join: Box<AgentJoin>,
    },
    AgentJoinSatisfied {
        thread_id: ThreadId,
        join_id: AgentJoinId,
        satisfied_by: Vec<DelegationId>,
    },
}

fn legacy_turn_action_policy_revision() -> String {
    "legacy-unversioned-policy".into()
}

impl ThreadEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ThreadCreated { .. } => "thread.created",
            Self::AdvisorConfigured { .. } => "advisor.configured",
            Self::ThreadArchived { .. } => "thread.archived",
            Self::ThreadRestored { .. } => "thread.restored",
            Self::GoalCreated { .. } => "thread.goal_created",
            Self::GoalUpdated { .. } => "thread.goal_updated",
            Self::GoalCleared { .. } => "thread.goal_cleared",
            Self::TurnExecutionBound { .. } => "turn.execution_bound",
            Self::AgentContextSeedCommitted { .. } => "agent.context_seed_committed",
            Self::HistoryImported { .. } => "thread.history_imported",
            Self::ForkHistoryImported { .. } => "thread.fork_history_imported",
            Self::ForkTurnImported { .. } => "thread.fork_turn_imported",
            Self::ForkHistoryImportCompleted { .. } => "thread.fork_history_import_completed",
            Self::ContextCheckpointCommitted { .. } => "context.checkpoint_committed",
            Self::ContextOverflowRecoveryCommitted { .. } => "context.overflow_recovery_committed",
            Self::TurnAccepted { .. } => "turn.accepted",
            Self::TurnStarted { .. } => "turn.started",
            Self::TurnSteered { .. } => "turn.steered",
            Self::TurnSteerDelivered { .. } => "turn.steer_delivered",
            Self::TurnExecutionAttempted { .. } => "turn.execution_attempted",
            Self::ModelUsageRecorded { .. } => "model.usage_recorded",
            Self::ModelInvocationRecorded { .. } => "model.invocation_recorded",
            Self::ItemCompleted { .. } => "item.completed",
            Self::HistoryPrefixBound { .. } => "history.prefix.bound",
            Self::PlanUpdated { .. } => "plan.updated",
            Self::InteractionRequested { .. } => "interaction.requested",
            Self::InteractionResolved { .. } => "interaction.resolved",
            Self::ToolExecutionStarted { .. } => "tool.execution_started",
            Self::ToolExecutionEscalated { .. } => "tool.execution_escalated",
            Self::InteractionCancelled { .. } => "interaction.cancelled",
            Self::TurnCompleted { .. } => "turn.completed",
            Self::TurnFailed { .. } => "turn.failed",
            Self::TurnCancelling { .. } => "turn.cancelling",
            Self::TurnInterrupted { .. } => "turn.interrupted",
            Self::DelegationRequested { .. } => "agent.delegation_requested",
            Self::DelegationStarted { .. } => "agent.delegation_started",
            Self::DelegationCancellationRequested { .. } => {
                "agent.delegation_cancellation_requested"
            }
            Self::AgentCancellationReceived { .. } => "agent.cancellation_received",
            Self::DelegationResultProduced { .. } => "agent.delegation_result_produced",
            Self::DelegationResultReceived { .. } => "agent.delegation_result_received",
            Self::AgentMessageSent { .. } => "agent.message_sent",
            Self::AgentMessageReceived { .. } => "agent.message_received",
            Self::AgentJoinRequested { .. } => "agent.join_requested",
            Self::AgentJoinSatisfied { .. } => "agent.join_satisfied",
        }
    }

    pub fn thread_id(&self) -> &ThreadId {
        match self {
            Self::ThreadCreated { thread_id, .. }
            | Self::AdvisorConfigured { thread_id, .. }
            | Self::ThreadArchived { thread_id, .. }
            | Self::ThreadRestored { thread_id }
            | Self::GoalCreated { thread_id, .. }
            | Self::GoalUpdated { thread_id, .. }
            | Self::GoalCleared { thread_id, .. }
            | Self::TurnExecutionBound { thread_id, .. }
            | Self::AgentContextSeedCommitted { thread_id, .. }
            | Self::HistoryImported { thread_id, .. }
            | Self::ForkHistoryImported { thread_id, .. }
            | Self::ForkTurnImported { thread_id, .. }
            | Self::ForkHistoryImportCompleted { thread_id, .. }
            | Self::ContextCheckpointCommitted { thread_id, .. }
            | Self::ContextOverflowRecoveryCommitted { thread_id, .. }
            | Self::TurnAccepted { thread_id, .. }
            | Self::TurnStarted { thread_id, .. }
            | Self::TurnSteered { thread_id, .. }
            | Self::TurnSteerDelivered { thread_id, .. }
            | Self::TurnExecutionAttempted { thread_id, .. }
            | Self::ModelUsageRecorded { thread_id, .. }
            | Self::ModelInvocationRecorded { thread_id, .. }
            | Self::ItemCompleted { thread_id, .. }
            | Self::HistoryPrefixBound { thread_id, .. }
            | Self::PlanUpdated { thread_id, .. }
            | Self::InteractionRequested { thread_id, .. }
            | Self::InteractionResolved { thread_id, .. }
            | Self::ToolExecutionStarted { thread_id, .. }
            | Self::ToolExecutionEscalated { thread_id, .. }
            | Self::InteractionCancelled { thread_id, .. }
            | Self::TurnCompleted { thread_id, .. }
            | Self::TurnFailed { thread_id, .. }
            | Self::TurnCancelling { thread_id, .. }
            | Self::TurnInterrupted { thread_id, .. }
            | Self::DelegationRequested { thread_id, .. }
            | Self::DelegationStarted { thread_id, .. }
            | Self::DelegationCancellationRequested { thread_id, .. }
            | Self::AgentCancellationReceived { thread_id, .. }
            | Self::DelegationResultProduced { thread_id, .. }
            | Self::DelegationResultReceived { thread_id, .. }
            | Self::AgentMessageSent { thread_id, .. }
            | Self::AgentMessageReceived { thread_id, .. }
            | Self::AgentJoinRequested { thread_id, .. }
            | Self::AgentJoinSatisfied { thread_id, .. } => thread_id,
        }
    }
}
