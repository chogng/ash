use crate::CoreError;
use crate::CreateBranchRequest;
use crate::ForkThreadRequest;
use crate::InterruptTurnRequest;
use crate::ReplaceThreadRequest;
use crate::ResolveTurnInteractionRequest;
use crate::RestoreMessageRequest;
use crate::RewindThreadRequest;
use crate::SequenceExpectation;
use crate::SessionView;
use crate::SetGoalRequest;
use crate::SetGoalResult;
use crate::ShellTurnInvocation;
use crate::StartThreadRequest;
use crate::SteerTurnRequest;
use crate::ThreadView;
use ash_protocol::AgentId;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::InteractionCancelReason;
use ash_protocol::MessageCheckpoint;
use ash_protocol::ModelRef;
use ash_protocol::RequestId;
use ash_protocol::SessionId;
use ash_protocol::ThreadArchiveReason;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolMode;
use ash_protocol::ToolProfileSnapshot;
use ash_protocol::TurnId;
use ash_protocol::TurnInstructions;
use ash_protocol::TurnKind;
use ash_protocol::UserInput;

/// A user submission after product input, model and instruction selection have been resolved.
pub struct SubmitTurnRequest {
    pub command_id: CommandId,
    pub expected_sequence: SequenceExpectation,
    pub model: Option<ModelRef>,
    pub advisor: Option<ash_protocol::AdvisorConfig>,
    pub kind: TurnKind,
    pub instructions: TurnInstructions,
    pub approval_mode: ApprovalMode,
    pub tool_mode: ToolMode,
    pub activated_skills: Vec<FrozenSkillActivation>,
    pub input: Vec<UserInput>,
}

pub struct SubmitShellRequest {
    pub command_id: CommandId,
    pub expected_sequence: SequenceExpectation,
    pub approval_mode: ApprovalMode,
    pub invocation: ShellTurnInvocation,
}

pub struct CompactThreadRequest {
    pub command_id: CommandId,
    pub expected_sequence: SequenceExpectation,
    pub model: Option<ModelRef>,
    pub retention_prompt: Option<String>,
}

/// Receipt returned after a new operation hands off execution, or an accepted operation is replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnReceipt {
    pub turn_id: TurnId,
    pub sequence: u64,
}

/// The user-controlled identity of a previously submitted command.
pub enum SubmittedCommand<'a> {
    Turn {
        kind: ash_protocol::TurnKind,
        input: &'a [UserInput],
        tool_mode: ToolMode,
    },
    Input {
        input: &'a [UserInput],
    },
}

/// Identity of a durable submission. Acceptance does not imply successful execution.
pub enum AcceptedCommand<'a> {
    Turn {
        input: &'a [UserInput],
        tool_mode: ToolMode,
        approval_mode: ApprovalMode,
    },
    Steer {
        input: &'a [UserInput],
        turn_id: &'a TurnId,
    },
}

/// Complete Agent operations consumed by product request handlers.
///
/// Implementations own command replay, durable mutation, execution handoff and failure recording.
/// Callers authorize the connection and resolve product-owned inputs; they never dispatch a Turn
/// separately or inspect internal command receipts. Read-only command queries may avoid repeated
/// product input resolution; submission operations must enforce replay safety independently.
pub trait AgentRuntime {
    fn read_thread(&self, thread_id: &ThreadId) -> Result<ThreadView, CoreError>;
    fn read_started_thread(&self, command_id: &CommandId) -> Result<Option<ThreadView>, CoreError>;
    fn read_session(&self, session_id: &SessionId) -> Result<SessionView, CoreError>;
    fn list_sessions(&self) -> Result<Vec<ash_protocol::Session>, CoreError>;
    fn read_session_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<ash_protocol::Session>, CoreError>;
    fn list_thread_catalog(&self) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, CoreError>;
    fn session_thread_catalog(
        &self,
        session_id: &SessionId,
    ) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, CoreError>;
    fn read_agent(&self, agent_id: &AgentId) -> Result<agent_graph_store::AgentRecord, CoreError>;
    fn list_agent_threads(
        &self,
        agent_id: &AgentId,
    ) -> Result<Vec<agent_graph_store::ThreadBinding>, CoreError>;
    fn start_thread(&self, request: StartThreadRequest) -> Result<ThreadView, CoreError>;
    fn create_branch(&self, request: CreateBranchRequest) -> Result<ThreadView, CoreError>;
    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadView, CoreError>;
    fn fork_session(&self, request: ForkThreadRequest) -> Result<ThreadView, CoreError>;
    fn replace_thread(&self, request: ReplaceThreadRequest) -> Result<ThreadView, CoreError>;
    fn rewind_thread(&self, request: RewindThreadRequest) -> Result<ThreadView, CoreError>;
    fn restore_message(&self, request: RestoreMessageRequest) -> Result<ThreadView, CoreError>;
    fn message_checkpoints(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<MessageCheckpoint>, CoreError>;
    fn submit_turn(
        &self,
        thread_id: &ThreadId,
        request: SubmitTurnRequest,
    ) -> Result<TurnReceipt, CoreError>;
    fn submit_shell(
        &self,
        thread_id: &ThreadId,
        request: SubmitShellRequest,
    ) -> Result<TurnReceipt, CoreError>;
    fn compact_thread(
        &self,
        thread_id: &ThreadId,
        request: CompactThreadRequest,
    ) -> Result<TurnReceipt, CoreError>;
    /// Reads the existing result for matching input without dispatching execution.
    /// `None` is not permission to dispatch; callers still submit through the complete operation.
    fn replay_turn(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
        command: SubmittedCommand<'_>,
    ) -> Result<Option<TurnReceipt>, CoreError>;
    /// Checks durable acceptance for queue coordination, independently of execution success.
    fn accepted_command(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
        command: AcceptedCommand<'_>,
    ) -> Result<Option<TurnId>, CoreError>;
    fn accepted_turn(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
    ) -> Result<Option<TurnId>, CoreError>;
    fn steer_turn(
        &self,
        thread_id: &ThreadId,
        request: SteerTurnRequest,
    ) -> Result<TurnReceipt, CoreError>;
    fn interrupt_turn(
        &self,
        thread_id: &ThreadId,
        request: InterruptTurnRequest,
    ) -> Result<u64, CoreError>;
    fn resolve_interaction(
        &self,
        thread_id: &ThreadId,
        request: ResolveTurnInteractionRequest,
    ) -> Result<u64, CoreError>;
    fn replay_advisor_configuration(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
        selection: &ash_protocol::AdvisorSelection,
    ) -> Result<Option<u64>, CoreError>;
    fn configure_advisor(
        &self,
        thread_id: &ThreadId,
        command_id: CommandId,
        expected_sequence: SequenceExpectation,
        selection: ash_protocol::AdvisorSelection,
    ) -> Result<u64, CoreError>;
    fn set_goal(
        &self,
        thread_id: &ThreadId,
        request: SetGoalRequest,
    ) -> Result<SetGoalResult, CoreError>;
    fn clear_goal(&self, thread_id: &ThreadId) -> Result<bool, CoreError>;
    fn archive_session(
        &self,
        session_id: &SessionId,
        command_id: &CommandId,
        reason: ThreadArchiveReason,
    ) -> Result<(), CoreError>;
    fn restore_session(&self, session_id: &SessionId) -> Result<ThreadView, CoreError>;
    fn delete_session_threads(&self, session_id: &SessionId) -> Result<(), CoreError>;
    fn thread_updates_after(
        &self,
        thread_id: &ThreadId,
        after_sequence: u64,
    ) -> Result<Vec<ThreadUpdateEnvelope>, CoreError>;
    fn has_active_turns(&self) -> Result<bool, CoreError>;
    fn cancel_interaction(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request_id: &RequestId,
        reason: InteractionCancelReason,
    ) -> Result<(), CoreError>;
    fn tool_profile(&self) -> Result<ToolProfileSnapshot, CoreError>;
    fn recover_agents(&self) -> Result<usize, CoreError>;
    fn recover_tools(&self) -> Result<usize, CoreError>;
    fn recover_extensions(&self) -> Result<usize, CoreError>;
}

/// Applies a host-observed deadline against the current durable interaction.
/// The host owns its timer and connection subscription; Core validates identity, cancels the wait
/// and records terminal failure. `None` means the request is no longer pending or has not expired.
pub trait InteractionLifecycle: Send + Sync {
    fn expire_interaction(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request_id: &RequestId,
        now_unix_ms: u64,
    ) -> Result<Option<Vec<ThreadUpdateEnvelope>>, CoreError>;
}
