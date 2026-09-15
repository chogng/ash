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
            command_id: CommandId::new("start").unwrap(),
            expected_sequence: SequenceExpectation::Exact(1),
            model: None,
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
