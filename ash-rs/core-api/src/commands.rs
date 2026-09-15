use ash_protocol::AgentResponse;
use ash_protocol::CommandId;
use ash_protocol::ItemId;
use ash_protocol::MessageBoundary;
use ash_protocol::RequestId;
use ash_protocol::SessionId;
use ash_protocol::ThreadGoal;
use ash_protocol::ThreadGoalStatus;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SequenceExpectation {
    Any,
    Exact(u64),
}

pub struct StartThreadRequest {
    pub agent_id: Option<ash_protocol::AgentId>,
    pub agent: Option<ash_protocol::AgentConfiguration>,
    pub command_id: CommandId,
    pub title: String,
}

pub struct CreateBranchRequest {
    pub agent_id: Option<ash_protocol::AgentId>,
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub title: String,
}

pub struct ForkThreadRequest {
    pub command_id: CommandId,
    pub source_thread_id: ThreadId,
    pub title: String,
}

/// Replaces an archived execution with a fresh branch of the same Agent.
pub struct ReplaceThreadRequest {
    pub command_id: CommandId,
    pub source_thread_id: ThreadId,
    pub title: String,
}

pub struct RewindThreadRequest {
    pub command_id: CommandId,
    pub source_thread_id: ThreadId,
    pub before_turn_id: TurnId,
    pub title: String,
}

/// Fields controlled by the Thread Goal API. `token_budget` is a double option so callers can
/// distinguish "leave unchanged" from "clear the budget".
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SetGoalRequest {
    pub objective: Option<String>,
    pub status: Option<ThreadGoalStatus>,
    pub token_budget: Option<Option<u64>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetGoalResult {
    pub goal: ThreadGoal,
    pub changed: bool,
    pub created: bool,
}

pub struct InterruptTurnRequest {
    pub command_id: CommandId,
    pub expected_sequence: SequenceExpectation,
    pub turn_id: TurnId,
}

/// Retry-safe client command that appends user input to one active Turn.
pub struct SteerTurnRequest {
    pub command_id: CommandId,
    pub expected_sequence: SequenceExpectation,
    pub turn_id: TurnId,
    pub input: Vec<UserInput>,
}

/// Client command to resolve exactly one outstanding Turn interaction.
pub struct ResolveTurnInteractionRequest {
    pub command_id: CommandId,
    pub expected_sequence: SequenceExpectation,
    pub turn_id: TurnId,
    pub request_id: RequestId,
    pub response: AgentResponse,
}

/// Concrete host invocation used to execute one explicit Shell Turn.
pub struct ShellTurnInvocation {
    pub command: String,
    pub program: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
}

pub struct RestoreMessageRequest {
    pub command_id: CommandId,
    pub source_thread_id: ThreadId,
    pub item_id: ItemId,
    pub boundary: MessageBoundary,
    pub title: String,
}
