use super::*;
use crate::AgentTreeLimits;
use crate::CreateThreadRequest;
use crate::InMemoryThreadStore;
use crate::NoThreadWorktreeBinder;
use crate::RequestTurnInteraction;
use ash_async_utils::CancellationToken;
use ash_protocol::AgentId;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::RequestId;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_protocol::ToolMode;
use ash_protocol::TurnId;
use ash_protocol::TurnInstructions;
use ash_protocol::TurnKind;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use ash_protocol::UserInputAnswer;
use ash_protocol::UserInputQuestion;
use core_api::AgentRuntime;
use core_api::ContextInspectionRequest;
use core_api::ContextInspectionScope;
use core_api::CoreError;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::ResolveTurnInteractionRequest;
use core_api::SequenceExpectation;
use core_api::SteerTurnRequest;
use core_api::SubmitTurnRequest;
use core_api::TurnReceipt;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct UnusedModel;
impl ModelService for UnusedModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        panic!("the recording execution backend must own dispatch")
    }
}
#[derive(Clone, Copy, PartialEq)]
enum Failure {
    None,
    Start,
    Steer,
    Resume,
}
struct Backend {
    failure: Failure,
    starts: AtomicUsize,
    steers: AtomicUsize,
    resumes: AtomicUsize,
}
impl Backend {
    fn new(failure: Failure) -> Self {
        Self {
            failure,
            starts: AtomicUsize::new(0),
            steers: AtomicUsize::new(0),
            resumes: AtomicUsize::new(0),
        }
    }
    fn dispatch(&self, operation: Failure, count: &AtomicUsize) -> Result<(), CoreError> {
        count.fetch_add(1, Ordering::SeqCst);
        if self.failure == operation {
            Err(CoreError::Execution("dispatch failed".into()))
        } else {
            Ok(())
        }
    }
}
impl TurnExecutionBackend for Backend {
    fn start(&self, _: &ThreadId, _: &TurnId) -> Result<(), CoreError> {
        self.dispatch(Failure::Start, &self.starts)
    }
    fn resume(&self, _: &ThreadId, _: &TurnId) -> Result<(), CoreError> {
        self.dispatch(Failure::Resume, &self.resumes)
    }
    fn steer(
        &self,
        _: &ThreadId,
        _: &TurnId,
        _: &CommandId,
        _: &[UserInput],
    ) -> Result<(), CoreError> {
        self.dispatch(Failure::Steer, &self.steers)
    }
}
#[derive(Default)]
struct Updates(std::sync::Mutex<Vec<ash_protocol::ThreadUpdateEnvelope>>);
impl core_api::ThreadUpdateSink for Updates {
    fn publish(&self, update: ash_protocol::ThreadUpdateEnvelope) {
        self.0.lock().unwrap().push(update);
    }
}

struct Fixture {
    store: Arc<InMemoryThreadStore>,
    threads: Arc<ThreadController>,
    agents: MultiAgentCoordinator,
    executor: TurnExecutor,
    backend: Backend,
    updates: Arc<Updates>,
    thread_id: ThreadId,
}
impl Fixture {
    fn new(failure: Failure) -> Self {
        let store = Arc::new(InMemoryThreadStore::default());
        let threads = Arc::new(ThreadController::with_store(store.clone()));
        let thread_id = ThreadId::new("thread").unwrap();
        threads
            .create_thread(CreateThreadRequest {
                execution_target: None,
                agent_id: AgentId::new("agent").unwrap(),
                agent: None,
                origin: ThreadOrigin::Root,
                session_id: SessionId::new("thread").unwrap(),
                thread_id: thread_id.clone(),
                title: "test".into(),
            })
            .unwrap();
        Self {
            store,
            agents: MultiAgentCoordinator::new(threads.clone(), AgentTreeLimits::default()),
            executor: TurnExecutor::without_tools(threads.clone(), Arc::new(UnusedModel)),
            threads,
            backend: Backend::new(failure),
            updates: Arc::new(Updates::default()),
            thread_id,
        }
    }
    fn runtime(&self) -> Runtime<'_> {
        Runtime::new(
            &self.threads,
            &self.agents,
            self.executor.clone(),
            &self.backend,
            &NoThreadWorktreeBinder,
            self.updates.clone(),
        )
    }
    fn submit(&self, text: &str) -> SubmitTurnRequest {
        SubmitTurnRequest {
            context_policy: Default::default(),
            mode: Default::default(),
            advisor: None,
            command_id: CommandId::new("start").unwrap(),
            expected_sequence: SequenceExpectation::Exact(1),
            model: None,
            reasoning_effort: None,
            kind: TurnKind::Coding,
            instructions: crate::test_turn_instructions(),
            approval_mode: ApprovalMode::default(),
            tool_mode: ToolMode::Direct,
            activated_skills: vec![],
            input: vec![UserInput::Text { text: text.into() }],
        }
    }
    fn steer(&self, turn: &TurnReceipt) -> SteerTurnRequest {
        SteerTurnRequest {
            command_id: CommandId::new("steer").unwrap(),
            expected_sequence: SequenceExpectation::Exact(turn.sequence),
            turn_id: turn.turn_id.clone(),
            input: vec![UserInput::Text {
                text: "continue here".into(),
            }],
        }
    }
}

#[test]
fn context_inspection_preserves_thread_history_without_execution_or_updates() {
    let fixture = Fixture::new(Failure::None);
    let runtime: &dyn AgentRuntime = &fixture.runtime();
    let turn = runtime
        .submit_turn(&fixture.thread_id, fixture.submit("inspect this history"))
        .unwrap();
    let before = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    fixture.updates.0.lock().unwrap().clear();
    let inspected = runtime
        .inspect_context(ContextInspectionRequest {
            context_policy: Default::default(),
            scope: ContextInspectionScope::Thread(&fixture.thread_id),
            model: None,
            instructions: crate::test_turn_instructions(),
            approval_mode: ApprovalMode::Manual,
            tool_mode: ToolMode::Direct,
        })
        .unwrap();
    assert!(
        inspected
            .context
            .categories
            .iter()
            .find(|category| category.category == ash_protocol::ModelContextCategory::Conversation)
            .unwrap()
            .tokens
            > 0
    );
    let after = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert_eq!(before.sequence, after.sequence);
    assert_eq!(before.items, after.items);
    assert_eq!(before.context_checkpoints, after.context_checkpoints);
    assert_eq!(after.turns.last().unwrap().turn_id, turn.turn_id);
    assert_eq!(fixture.backend.starts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.backend.resumes.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.backend.steers.load(Ordering::SeqCst), 0);
    assert!(fixture.updates.0.lock().unwrap().is_empty());
}

#[test]
fn submitted_turn_replays_one_receipt_and_rejects_changed_input() {
    let fixture = Fixture::new(Failure::None);
    let runtime: &dyn AgentRuntime = &fixture.runtime();
    let first = runtime
        .submit_turn(&fixture.thread_id, fixture.submit("hello"))
        .unwrap();
    let mut retry = fixture.submit("hello");
    retry.instructions =
        TurnInstructions::new("changed", "changed", "changed", "changed host defaults").unwrap();
    assert_eq!(
        runtime.submit_turn(&fixture.thread_id, retry).unwrap(),
        first
    );
    assert_eq!(fixture.backend.starts.load(Ordering::SeqCst), 1);
    assert!(matches!(
        runtime.submit_turn(&fixture.thread_id, fixture.submit("different")),
        Err(CoreError::CommandConflict)
    ));
    assert_eq!(
        runtime
            .read_thread(&fixture.thread_id)
            .unwrap()
            .public_thread(),
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .public_thread()
    );
}

#[test]
fn submitted_turn_rejects_replay_with_a_different_collaboration_mode() {
    let fixture = Fixture::new(Failure::None);
    let runtime: &dyn AgentRuntime = &fixture.runtime();
    let mut first_request = fixture.submit("hello");
    first_request.mode = ash_protocol::CollaborationMode::Plan;
    runtime
        .submit_turn(&fixture.thread_id, first_request)
        .unwrap();

    let mut retry = fixture.submit("hello");
    retry.mode = ash_protocol::CollaborationMode::Debug;
    assert!(matches!(
        runtime.submit_turn(&fixture.thread_id, retry),
        Err(CoreError::CommandConflict)
    ));
    assert_eq!(fixture.backend.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.read_thread(&fixture.thread_id).unwrap().turns[0].mode,
        ash_protocol::CollaborationMode::Plan
    );
}

#[test]
fn rejected_start_is_durably_failed_and_retry_never_dispatches_again() {
    let fixture = Fixture::new(Failure::Start);
    assert!(
        fixture
            .runtime()
            .submit_turn(&fixture.thread_id, fixture.submit("hello"))
            .is_err()
    );
    let recovered = ThreadController::with_store(fixture.store.clone())
        .read_thread(&fixture.thread_id)
        .unwrap();
    assert_eq!(recovered.turns[0].status, TurnStatus::Failed);
    assert!(
        fixture
            .runtime()
            .submit_turn(&fixture.thread_id, fixture.submit("hello"))
            .is_err()
    );
    assert_eq!(fixture.backend.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        *fixture.updates.0.lock().unwrap(),
        fixture
            .threads
            .thread_updates_after(&fixture.thread_id, 1)
            .unwrap()
    );
}

#[test]
fn failed_agent_recovery_dispatch_does_not_stop_other_children_or_retry_failed_turns() {
    let mut fixture = Fixture::new(Failure::None);
    let parent = fixture
        .runtime()
        .submit_turn(&fixture.thread_id, fixture.submit("delegate work"))
        .unwrap();
    let mut children = Vec::new();
    for id in ["first-child", "second-child"] {
        children.push(
            fixture
                .agents
                .spawn(crate::SpawnAgentRequest {
                    delegation_id: ash_protocol::DelegationId::new(id).unwrap(),
                    agent_id: None,
                    session_id: SessionId::new("thread").unwrap(),
                    parent_thread_id: fixture.thread_id.clone(),
                    parent_turn_id: parent.turn_id.clone(),
                    task: ash_protocol::DelegatedTask {
                        title: id.into(),
                        instructions: "Review the task".into(),
                    },
                    role: None,
                    base_instructions: crate::test_turn_instructions(),
                    inheritance: ash_protocol::AgentContextMode::Fresh,
                    policy_ceiling: ash_protocol::DelegatedPolicyCeiling {
                        policy_revision: fixture.executor.policy_revision(),
                    },
                    capability_scope: ash_protocol::AgentCapabilityScope {
                        tools: vec![],
                        delegation_tools: vec![],
                        skills: vec![],
                    },
                })
                .unwrap(),
        );
    }
    fixture.backend.failure = Failure::Start;
    assert_eq!(fixture.runtime().recover_agents().unwrap(), 0);
    assert_eq!(fixture.backend.starts.load(Ordering::SeqCst), 3);
    let persisted = ThreadController::with_store(fixture.store.clone());
    for child in &children {
        let failed = persisted.read_thread(&child.child_thread_id).unwrap();
        assert_eq!(failed.turns[0].turn_id, child.child_turn_id);
        assert_eq!(failed.turns[0].status, TurnStatus::Failed);
        assert_eq!(
            failed.turns[0].failure,
            Some(ash_protocol::StableTurnError::model_invocation_failed())
        );
        assert!(fixture.updates.0.lock().unwrap().iter().any(|update| {
            update.thread_id == child.child_thread_id
                && matches!(
                    &update.update,
                    ash_protocol::ThreadUpdate::Committed {
                        event: ash_protocol::ThreadEvent::TurnFailed { turn_id, .. }
                    } if turn_id == &child.child_turn_id
                )
        }));
    }
    assert_eq!(fixture.runtime().recover_agents().unwrap(), 0);
    assert_eq!(fixture.backend.starts.load(Ordering::SeqCst), 3);
}

#[test]
fn steer_delivery_and_its_receipt_are_owned_by_the_runtime() {
    let fixture = Fixture::new(Failure::None);
    let runtime = fixture.runtime();
    let turn = runtime
        .submit_turn(&fixture.thread_id, fixture.submit("hello"))
        .unwrap();
    let first = runtime
        .steer_turn(&fixture.thread_id, fixture.steer(&turn))
        .unwrap();
    let repeated = runtime
        .steer_turn(&fixture.thread_id, fixture.steer(&turn))
        .unwrap();
    assert_eq!(first, repeated);
    assert_eq!(fixture.backend.steers.load(Ordering::SeqCst), 1);
    let stored = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert_eq!(
        stored.steer_deliveries[&CommandId::new("steer").unwrap()],
        first.sequence
    );
}

#[test]
fn failed_steer_terminates_the_turn_without_repeating_delivery() {
    let fixture = Fixture::new(Failure::Steer);
    let runtime = fixture.runtime();
    let turn = runtime
        .submit_turn(&fixture.thread_id, fixture.submit("hello"))
        .unwrap();
    assert!(
        runtime
            .steer_turn(&fixture.thread_id, fixture.steer(&turn))
            .is_err()
    );
    assert!(
        runtime
            .steer_turn(&fixture.thread_id, fixture.steer(&turn))
            .is_err()
    );
    assert_eq!(fixture.backend.steers.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.read_thread(&fixture.thread_id).unwrap().turns[0].status,
        TurnStatus::Failed
    );
}

#[test]
fn failed_interaction_resume_keeps_the_answer_and_records_terminal_failure() {
    let fixture = Fixture::new(Failure::Resume);
    let runtime = fixture.runtime();
    let turn = runtime
        .submit_turn(&fixture.thread_id, fixture.submit("hello"))
        .unwrap();
    let request_id = RequestId::new("question").unwrap();
    let pending = fixture
        .threads
        .request_turn_interaction(
            &fixture.thread_id,
            &turn.turn_id,
            RequestTurnInteraction {
                request_id: request_id.clone(),
                item_id: None,
                deadline: None,
                request: AgentRequest::UserInput {
                    request: RequestUserInput {
                        questions: vec![UserInputQuestion {
                            id: "choice".into(),
                            header: "Choice".into(),
                            question: "Which one?".into(),
                            options: vec![],
                            allow_free_form: true,
                        }],
                    },
                },
            },
        )
        .unwrap();
    fixture.updates.0.lock().unwrap().clear();
    let request = || ResolveTurnInteractionRequest {
        command_id: CommandId::new("answer").unwrap(),
        expected_sequence: SequenceExpectation::Exact(pending.sequence),
        turn_id: turn.turn_id.clone(),
        request_id: request_id.clone(),
        response: AgentResponse::UserInput {
            response: RequestUserInputResponse {
                answers: std::collections::BTreeMap::from([(
                    "choice".into(),
                    UserInputAnswer {
                        value: "yes".into(),
                    },
                )]),
            },
        },
    };
    assert!(
        runtime
            .resolve_interaction(&fixture.thread_id, request())
            .is_err()
    );
    assert_eq!(fixture.backend.resumes.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.read_thread(&fixture.thread_id).unwrap().turns[0].status,
        TurnStatus::Failed
    );
    runtime
        .resolve_interaction(&fixture.thread_id, request())
        .unwrap();
    assert_eq!(fixture.backend.resumes.load(Ordering::SeqCst), 1);
    assert_eq!(
        *fixture.updates.0.lock().unwrap(),
        fixture
            .threads
            .thread_updates_after(&fixture.thread_id, pending.sequence)
            .unwrap()
    );
}

#[test]
fn interrupt_replay_does_not_cancel_children_of_a_later_turn() {
    let fixture = Fixture::new(Failure::None);
    let runtime = fixture.runtime();
    let first = runtime
        .submit_turn(&fixture.thread_id, fixture.submit("first"))
        .unwrap();
    let spawn = |turn_id: &TurnId, delegation_id: &str| {
        let parent = fixture.threads.read_thread(&fixture.thread_id).unwrap();
        let turn = parent
            .turns
            .iter()
            .find(|turn| turn.turn_id == *turn_id)
            .unwrap();
        fixture
            .agents
            .spawn(crate::SpawnAgentRequest {
                delegation_id: ash_protocol::DelegationId::new(delegation_id).unwrap(),
                agent_id: None,
                session_id: parent.session_id.clone(),
                parent_thread_id: fixture.thread_id.clone(),
                parent_turn_id: turn_id.clone(),
                task: ash_protocol::DelegatedTask {
                    title: "review".into(),
                    instructions: "Review this Turn".into(),
                },
                role: None,
                base_instructions: crate::test_turn_instructions(),
                inheritance: ash_protocol::AgentContextMode::Fresh,
                policy_ceiling: ash_protocol::DelegatedPolicyCeiling {
                    policy_revision: turn.policy_revision.clone(),
                },
                capability_scope: ash_protocol::AgentCapabilityScope {
                    tools: vec![],
                    delegation_tools: vec![],
                    skills: vec![],
                },
            })
            .unwrap()
    };
    let first_child = spawn(&first.turn_id, "first-child");
    let interrupt_sequence = fixture
        .threads
        .read_thread(&fixture.thread_id)
        .unwrap()
        .sequence;
    let interrupt = || InterruptTurnRequest {
        command_id: CommandId::new("interrupt-first").unwrap(),
        expected_sequence: SequenceExpectation::Exact(interrupt_sequence),
        turn_id: first.turn_id.clone(),
    };
    let interrupted = runtime
        .interrupt_turn(&fixture.thread_id, interrupt())
        .unwrap();
    assert_eq!(
        fixture
            .threads
            .read_thread(&first_child.child_thread_id)
            .unwrap()
            .turns[0]
            .status,
        TurnStatus::Interrupted
    );
    let mut next_request = fixture.submit("next");
    next_request.command_id = CommandId::new("next").unwrap();
    next_request.expected_sequence = SequenceExpectation::Exact(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .sequence,
    );
    let next = runtime
        .submit_turn(&fixture.thread_id, next_request)
        .unwrap();
    let next_child = spawn(&next.turn_id, "next-child");
    let before_parent = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let before_child = fixture
        .threads
        .read_thread(&next_child.child_thread_id)
        .unwrap();
    fixture.updates.0.lock().unwrap().clear();
    assert_eq!(
        runtime
            .interrupt_turn(&fixture.thread_id, interrupt())
            .unwrap(),
        interrupted
    );
    let after_child = fixture
        .threads
        .read_thread(&next_child.child_thread_id)
        .unwrap();
    assert_eq!(after_child.sequence, before_child.sequence);
    assert_eq!(after_child.turns[0].status, before_child.turns[0].status);
    let after_parent = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert_eq!(after_parent.sequence, before_parent.sequence);
    assert!(!after_parent.delegations[&next_child.delegation_id].cancellation_requested);
    assert!(fixture.updates.0.lock().unwrap().is_empty());
}
