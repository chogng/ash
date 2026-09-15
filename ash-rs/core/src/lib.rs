//! Ash's Agent lifecycle, Turn execution, context assembly, and outbound service ports.

mod action_policy_service;
mod attachment_model_service;
mod capabilities;
mod context;
mod context_manager;
mod history;
mod hooks;
mod message_checkpoint;
mod image_preparation;
mod multi_agent;
mod services;
mod state;
#[cfg(test)]
mod test_image;
mod thread_controller;
mod thread_reducer;
mod thread_worktree;
mod tool_profile;
mod tool_repetition;
mod turn;
mod turn_execution_observer;

pub use action_policy_service::durable_approval_request;
pub use ash_prompts::PromptArtifact;
pub(crate) use context::ContextAssembler;
pub use context::ContextBudget;
pub use context::ContextCompactionLimit;
pub use context::ContextCompactionRequest;
pub use context::ContextCompactionResult;
pub use context::ContextCompactionService;
pub use context::ContextTokenCount;
pub use context::ContextTokenMeasurementCapability;
pub use context::ContextTokenMeasurementOutcome;
pub use context::HarnessContext;
pub use context::HarnessContextProvider;
pub use context::HarnessContextRequest;
pub use context::HarnessInstructions;
pub use context::ResolvedContextBudget;
pub use hooks::NoHooks;
pub use multi_agent::AgentCommandDisposition;
pub use multi_agent::AgentTreeLimits;
pub use multi_agent::CompleteDelegationRequest;
pub use multi_agent::DeliveredAgentMessage;
pub use multi_agent::JoinAgentsRequest;
pub use multi_agent::JoinedAgents;
pub use multi_agent::MultiAgentCoordinator;
pub use multi_agent::SendAgentMessageRequest;
pub use multi_agent::SpawnAgentRequest;
pub use multi_agent::SpawnedAgent;
pub use multi_agent::project_agent_tree;
pub use services::AutoReviewedToolGrant;
pub use services::ContextEvidence;
pub use services::ContextSource;
pub use services::ContextSourceRequest;
pub use services::ExecPolicyToolGrant;
pub use services::ModelToolCatalogSnapshot;
pub use services::NoThreadUpdates;
pub use services::NoTools;
pub use services::OneTimeToolGrant;
pub use services::PermissionBypassToolGrant;
pub use services::ToolAuthorization;
pub use services::ToolExecutionFacts;
pub use services::ToolExecutionIdentity;
pub use services::ToolInteractionService;
pub use services::ToolOutputSink;
pub use services::ToolService;
pub use services::ToolUserInputOutcome;
pub use state::ItemStatus;
pub use state::ToolCallStatus;
pub use thread_controller::CancelTurnInteractionRequest;
pub use thread_controller::CancelledTurnInteraction;
pub use thread_controller::CompletedTurn;
pub use thread_controller::CreateAgentThreadRequest;
pub use thread_controller::CreateBranchRequest;
pub use thread_controller::CreateForkedThreadRequest;
pub use thread_controller::CreateRewoundThreadRequest;
pub use thread_controller::CreateThreadRequest;
pub use thread_controller::ForkThreadRequest;
pub use thread_controller::InMemoryThreadStore;
pub use thread_controller::InterruptTurnDisposition;
pub use thread_controller::InterruptTurnRequest;
pub use thread_controller::InterruptTurnResult;
pub use thread_controller::RecordToolCallRequest;
pub use thread_controller::RecordToolResultRequest;
pub use thread_controller::RecordedToolCall;
pub use thread_controller::RecordedToolResult;
pub use thread_controller::ReplaceThreadRequest;
pub use thread_controller::RequestTurnInteraction;
pub use thread_controller::RequestedTurnInteraction;
pub use thread_controller::ResolveTurnInteractionDisposition;
pub use thread_controller::ResolveTurnInteractionRequest;
pub use thread_controller::ResolveTurnInteractionResult;
pub use thread_controller::RestoreMessageRequest;
pub use thread_controller::RewindThreadRequest;
pub use thread_controller::SequenceExpectation;
pub use thread_controller::SetGoalRequest;
pub use thread_controller::SetGoalResult;
pub use thread_controller::ShellTurnInvocation;
pub use thread_controller::StartContextCompactionRequest;
pub use thread_controller::StartGoalTurnRequest;
pub use thread_controller::StartShellTurnRequest;
pub use thread_controller::StartThreadRequest;
pub use thread_controller::StartTurnDisposition;
pub use thread_controller::StartTurnRequest;
pub use thread_controller::StartTurnResult;
pub use thread_controller::SteerTurnDisposition;
pub use thread_controller::SteerTurnRequest;
pub use thread_controller::SteerTurnResult;
pub use thread_controller::ThreadController;
pub use thread_controller::ThreadExecutionContext;
pub use thread_controller::ToolCallOutput;
pub use thread_controller::UpdatePlanDisposition;
pub use thread_controller::UpdatePlanResult;
pub use thread_reducer::DelegationSnapshot;
pub use thread_reducer::ResolvedTurnInteraction;
pub use thread_reducer::ThreadCommandResult;
pub use thread_reducer::ThreadCommandSnapshot;
pub use thread_reducer::ThreadSnapshot;
pub use thread_reducer::ToolExecutionStartSnapshot;
pub use thread_reducer::TurnSnapshot;
pub use thread_reducer::reduce_thread_event;
pub use thread_worktree::NoThreadWorktreeBinder;
pub use turn::TurnExecutionBackend;
pub use turn::TurnExecutionOutcome;
pub use turn::TurnExecutor;
pub use turn_execution_observer::NoTurnExecutionObserver;

#[cfg(test)]
pub(crate) fn test_turn_instructions() -> ash_protocol::TurnInstructions {
    ash_protocol::TurnInstructions::new(
        "core-tests",
        "test/base-instructions",
        "test-v1",
        "test instructions",
    )
    .expect("static test Turn instructions are valid")
}
pub use ash_protocol::ProcessExecutionOutput;
pub use ash_protocol::ProcessExitStatus;
pub use ash_protocol::SandboxDenialOutput;
pub use ash_protocol::ToolExecutionOutput;
pub use ash_protocol::ToolReplaySafety;
pub use ash_protocol::TurnStatus;
pub use ash_thread_store::AppendBatchResult;
pub use ash_thread_store::ThreadEventBatch;
pub use ash_thread_store::ThreadStore;
pub use ash_thread_store::ThreadStoreError;
pub use ash_thread_store::validate_append_batch;

#[cfg(test)]
#[path = "thread_controller_tests.rs"]
mod tests;
pub use capabilities::UnsupportedBrowserCapability;

mod approval_mode;
pub use approval_mode::ApprovalModeActionPolicyService;
pub use context::TimeContextProvider;

#[cfg(test)]
#[path = "time_context_tests.rs"]
mod time_context_tests;

pub use context::HarnessInstruction;
pub use context::InstructionActivation;
pub use context::InstructionScope;

use core_api::ActionPolicyService;
use core_api::AfterToolHookRequest;
use core_api::BeforeToolHookDecision;
use core_api::BeforeToolHookRequest;
use core_api::CheckpointCapture;
use core_api::CoreError;
use core_api::HookOutcome;
use core_api::HookService;
use core_api::LeaseGuard;
use core_api::MessageCheckpointSource;
use core_api::ModelImageInputPolicy;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::ModelStreamSink;
use core_api::ThreadUpdateSink;
use core_api::ThreadWorktreeBinder;
use core_api::ThreadWorktreeBindingRequest;
use core_api::TurnCompletedHookRequest;
use core_api::TurnExecutionFinished;
use core_api::TurnExecutionKind;
use core_api::TurnExecutionObserver;
use core_api::TurnExecutionStarted;
use core_api::TurnExecutionTerminalState;
use core_api::TurnToolExecutionFinished;
use core_api::TurnToolExecutionStarted;
use core_api::WriterLease;
