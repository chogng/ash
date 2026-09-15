use ash_protocol::AgentConfiguration;
use ash_protocol::ApprovalMode;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::ModelContextUsage;
use ash_protocol::ModelRef;
use ash_protocol::ModelReferenceCostSummary;
use ash_protocol::ModelUsageSummary;
use ash_protocol::PlanUpdate;
use ash_protocol::SessionId;
use ash_protocol::StableTurnError;
use ash_protocol::Thread;
use ash_protocol::ThreadArchiveReason;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadStatus;
use ash_protocol::ToolMode;
use ash_protocol::ToolProfileSnapshot;
use ash_protocol::Turn;
use ash_protocol::TurnExecutionBinding;
use ash_protocol::TurnId;
use ash_protocol::TurnInstructions;
use ash_protocol::TurnInteraction;
use ash_protocol::TurnKind;
use ash_protocol::TurnStatus;

/// Threads and their Agent tree derived from the same read, without retained session state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionView {
    pub threads: Vec<ThreadView>,
    pub agent_tree: ash_protocol::AgentTreeProjection,
}

/// Immutable read result. Core retains execution state and command receipts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadView {
    pub agent_id: ash_protocol::AgentId,
    pub origin: ash_protocol::ThreadOrigin,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub created_at_unix_ms: u64,
    pub parent_thread_id: Option<ThreadId>,
    pub forked_from_id: Option<ThreadId>,
    pub title: String,
    pub status: ThreadStatus,
    pub archived_at_unix_ms: Option<u64>,
    pub archive_reason: Option<ThreadArchiveReason>,
    pub turn_execution_binding: Option<TurnExecutionBinding>,
    pub sequence: u64,
    pub usage: ModelUsageSummary,
    pub reference_cost: ModelReferenceCostSummary,
    pub goal: Option<ash_protocol::ThreadGoal>,
    pub turns: Vec<TurnView>,
    pub items: Vec<ThreadItem>,
    pub agent: Option<AgentConfiguration>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnView {
    pub turn_id: TurnId,
    pub status: TurnStatus,
    pub status_changed_at_unix_ms: u64,
    pub started_at_unix_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub kind: TurnKind,
    pub instructions: Option<TurnInstructions>,
    pub model: Option<ModelRef>,
    pub approval_mode: ApprovalMode,
    pub tool_mode: ToolMode,
    pub activated_skills: Vec<FrozenSkillActivation>,
    pub failure: Option<StableTurnError>,
    pub pending_interaction: Option<TurnInteraction>,
    pub tool_profile: Option<ToolProfileSnapshot>,
    pub plan: Option<PlanUpdate>,
    pub usage: ModelUsageSummary,
    pub context_usage: Option<ModelContextUsage>,
}

impl ThreadView {
    pub fn agent_configuration(&self) -> Option<&AgentConfiguration> {
        self.agent.as_ref()
    }
    pub fn public_thread(&self) -> Thread {
        Thread {
            agent_id: self.agent_id.clone(),
            origin: self.origin.clone(),
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            parent_thread_id: self.parent_thread_id.clone(),
            forked_from_id: self.forked_from_id.clone(),
            title: self.title.clone(),
            status: self.status,
            sequence: self.sequence,
            usage: self.usage.clone(),
            reference_cost: self.reference_cost.clone(),
            goal: self.goal.clone(),
            turns: self
                .turns
                .iter()
                .map(|turn| Turn {
                    turn_id: turn.turn_id.clone(),
                    status: turn.status,
                    kind: turn.kind,
                    instructions: turn.instructions.clone(),
                    model: turn.model.clone(),
                    tool_profile: turn.tool_profile.clone(),
                    tool_mode: turn.tool_mode,
                    approval_mode: turn.approval_mode,
                    usage: turn.usage.clone(),
                    context_usage: turn.context_usage.clone(),
                    items: self
                        .items
                        .iter()
                        .filter(|item| item.turn_id() == &turn.turn_id)
                        .cloned()
                        .collect(),
                    plan: turn.plan.clone(),
                    pending_interaction: turn
                        .pending_interaction
                        .as_ref()
                        .map(TurnInteraction::pending_state),
                    error: turn.failure.clone(),
                })
                .collect(),
        }
    }
    pub fn completed_turn_duration_ms(&self) -> u64 {
        self.turns
            .iter()
            .filter_map(|turn| turn.duration_ms)
            .fold(0, u64::saturating_add)
    }
    pub fn active_turn_started_at_unix_ms(&self) -> Option<u64> {
        self.turns
            .iter()
            .rev()
            .find(|turn| {
                matches!(
                    turn.status,
                    TurnStatus::Running
                        | TurnStatus::WaitingForApproval
                        | TurnStatus::WaitingForUserInput
                        | TurnStatus::WaitingForCapability
                        | TurnStatus::Cancelling
                )
            })?
            .started_at_unix_ms
    }
}
