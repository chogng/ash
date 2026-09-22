use super::*;
use action_policy::ExecutionDecision;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::StartTurnRequest;
use ash_core::TurnExecutor;
use core_api::ActionPolicyService;
use core_api::SequenceExpectation;

use core_api::ModelSelection;
use protocol::AdvisorSelection;
use protocol::CommandId;
use protocol::ModelRef;
use protocol::ModelRequest;
use protocol::ModelResponse;
use protocol::ModelUsage;
use protocol::ResponseItem;
use protocol::SessionId;
use protocol::StopReason;
use protocol::ThreadId;
use protocol::ThreadItem;
use protocol::TurnKind;
use protocol::TurnStatus;
use protocol::UserInput;
use std::collections::VecDeque;
use std::sync::Mutex;

struct Model {
    budget: Mutex<ash_core::ContextBudget>,
    responses: Mutex<VecDeque<Result<ModelResponse, CoreError>>>,
    block: std::sync::atomic::AtomicBool,
    cancelled: std::sync::atomic::AtomicBool,
    requests: Mutex<Vec<(ModelRef, ModelRequest)>>,
}
impl ModelService for Model {
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ash_core::ContextBudget, CoreError> {
        Ok(*self.budget.lock().unwrap())
    }
    fn invoke(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let ModelSelection::Session(model) = selection else {
            panic!("model must be frozen")
        };
        self.requests
            .lock()
            .unwrap()
            .push((model.clone(), request.clone()));
        if self.block.load(std::sync::atomic::Ordering::SeqCst) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while !cancellation.is_cancelled() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "advisor was not cancelled"
                );
                std::thread::yield_now();
            }
            self.cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(CoreError::Cancelled("test cancellation".into()));
        }
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected model request")
    }
}
struct Allow;
impl ActionPolicyService for Allow {
    fn revision(&self) -> String {
        "test-policy".into()
    }
    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunUnsandboxed {
            grant_id: action_policy::GrantId::new("test"),
        })
    }
}
fn model(name: &str) -> ModelRef {
    ModelRef {
        provider: protocol::ProviderId::new("test").unwrap(),
        model: protocol::ModelId::new(name).unwrap(),
    }
}
fn text(text: &str, input: u64) -> ModelResponse {
    ModelResponse {
        output: vec![ResponseItem::Text(text.into())],
        billing: None,
        stop_reason: StopReason::Completed,
        usage: Some(ModelUsage {
            input_tokens: Some(input),
            output_tokens: Some(7),
            cached_input_tokens: Some(0),
            cache_write_input_tokens: Some(0),
            reasoning_tokens: None,
        }),
    }
}
fn consult(id: &str) -> ModelResponse {
    ModelResponse {
        output: vec![ResponseItem::ToolCall(ToolCall {
            id: protocol::ToolCallId::new(id).unwrap(),
            name: protocol::ToolName::new(TOOL_NAME).unwrap(),
            arguments: json!({"question":"Check the proposed change"}),
        })],
        usage: None,
        billing: None,
        stop_reason: StopReason::ToolUse,
    }
}
struct Fixture {
    threads: Arc<ThreadController>,
    id: ThreadId,
    model: Arc<Model>,
    executor: TurnExecutor,
}
impl Fixture {
    fn new(responses: impl IntoIterator<Item = Result<ModelResponse, CoreError>>) -> Self {
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let id = ThreadId::new("thread").unwrap();
        threads
            .create_thread(CreateThreadRequest {
                agent_id: protocol::AgentId::new("agent").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: SessionId::new("session").unwrap(),
                thread_id: id.clone(),
                title: "advisor test".into(),
            })
            .unwrap();
        let model = Arc::new(Model {
            budget: Mutex::new(ash_core::ContextBudget::provider_managed()),
            block: Default::default(),
            cancelled: Default::default(),
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        });
        let tools = Arc::new(AdvisorToolService::new(
            threads.clone(),
            model.clone(),
            ActionPolicyRevision::new("test-policy"),
        ));
        let executor = TurnExecutor::new(threads.clone(), model.clone(), tools, Arc::new(Allow));
        Self {
            threads,
            id,
            model,
            executor,
        }
    }
    fn start(&self, kind: TurnKind, advisor: Option<AdvisorConfig>) -> protocol::TurnId {
        self.threads
            .start_turn(
                &self.id,
                StartTurnRequest {
                    command_id: CommandId::new("start").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: Some(model("worker")),
                    advisor,
                    kind,
                    instructions: protocol::TurnInstructions::new(
                        "test",
                        "constraints",
                        "1",
                        "Preserve user changes",
                    )
                    .unwrap(),
                    policy_revision: "test-policy".into(),
                    approval_mode: protocol::ApprovalMode::default(),
                    tool_mode: protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: "Check the actual task evidence".into(),
                    }],
                },
            )
            .unwrap()
            .turn_id
    }
    fn run(&self, turn: &protocol::TurnId) {
        self.executor.start(&self.id, turn).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let status = self
                .threads
                .read_thread(&self.id)
                .unwrap()
                .turns
                .last()
                .unwrap()
                .status;
            if matches!(
                status,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "advisor Turn did not finish"
            );
            std::thread::yield_now();
        }
    }
    fn results(&self) -> Vec<(bool, serde_json::Value)> {
        self.threads
            .read_thread(&self.id)
            .unwrap()
            .items
            .into_iter()
            .filter_map(|item| match item {
                ThreadItem::ToolResult { text, is_error, .. } => {
                    Some((is_error, serde_json::from_str(&text).unwrap()))
                }
                _ => None,
            })
            .collect()
    }
}
#[test]
fn manual_consultation_uses_frozen_evidence_without_worker_or_tools() {
    let f = Fixture::new([Ok(text("Check the cancellation path", 400))]);
    let config = AdvisorConfig::new(model("reviewer"));
    let turn = f.start(TurnKind::Advisor, Some(config.clone()));
    f.threads
        .configure_advisor(
            &f.id,
            CommandId::new("off").unwrap(),
            SequenceExpectation::Any,
            AdvisorSelection::Off,
        )
        .unwrap();
    f.run(&turn);
    let requests = f.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, config.model);
    let request = &requests[0].1;
    assert!(request.tools.is_empty());
    assert_eq!(request.tool_choice, protocol::ToolChoice::None);
    assert!(!request.parallel_tool_calls);
    assert_eq!(request.max_output_tokens, Some(config.max_output_tokens));
    assert!(
        request.instructions.as_deref().unwrap().contains(
            agent_roles::built_in_roles()
                .get("advisor")
                .unwrap()
                .role_instructions()
        )
    );
    let evidence = serde_json::to_string(request).unwrap();
    assert!(evidence.contains("Check the actual task evidence"));
    assert!(evidence.contains("Preserve user changes"));
    assert!(!evidence.contains("advisor-turn"));
    let snapshot = f.threads.read_thread(&f.id).unwrap();
    assert_eq!(snapshot.turns[0].status, TurnStatus::Completed);
    assert_eq!(snapshot.turns[0].advisor, Some(config));
    assert!(snapshot.turns[0].context_usage.is_none());
    assert_eq!(snapshot.usage.input_tokens.reported, 400);
    assert_eq!(f.results()[0].1["advice"], "Check the cancellation path");
}
#[test]
fn automatic_advice_returns_to_worker_and_enforces_call_limit() {
    let f = Fixture::new([
        Ok(consult("one")),
        Ok(text("Use one writer", 900)),
        Ok(consult("two")),
        Ok(text("Implemented", 30)),
    ]);
    let mut config = AdvisorConfig::new(model("reviewer"));
    config.max_calls = 1;
    let turn = f.start(TurnKind::Coding, Some(config));
    f.run(&turn);
    let requests = f.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[1].0, model("reviewer"));
    assert!(
        requests[1].1.instructions.as_deref().unwrap().contains(
            agent_roles::built_in_roles()
                .get("advisor")
                .unwrap()
                .role_instructions()
        )
    );
    for index in [0, 2, 3] {
        assert!(
            !requests[index].1.instructions.as_deref().unwrap().contains(
                agent_roles::built_in_roles()
                    .get("advisor")
                    .unwrap()
                    .role_instructions()
            )
        );
    }
    assert!(
        serde_json::to_string(&requests[2].1)
            .unwrap()
            .contains("Use one writer")
    );
    assert_eq!(f.results()[1].1["status"], "limitReached");
    assert!(f.results()[1].0);
    let snapshot = f.threads.read_thread(&f.id).unwrap();
    assert_eq!(
        snapshot.turns[0]
            .context_usage
            .as_ref()
            .unwrap()
            .used_tokens,
        37
    );
    assert_eq!(snapshot.usage.input_tokens.reported, 930);
}
#[test]
fn disabled_advisor_is_absent_from_worker_catalog() {
    let f = Fixture::new([Ok(text("done", 10))]);
    let turn = f.start(TurnKind::Coding, None);
    f.run(&turn);
    assert!(
        f.model.requests.lock().unwrap()[0]
            .1
            .tools
            .iter()
            .all(|tool| tool.name.as_str() != TOOL_NAME)
    );
}
#[test]
fn provider_failure_is_visible_and_does_not_switch_models() {
    let f = Fixture::new([Err(CoreError::ModelAuthFailed)]);
    let turn = f.start(
        TurnKind::Advisor,
        Some(AdvisorConfig::new(model("reviewer"))),
    );
    f.run(&turn);
    assert_eq!(f.model.requests.lock().unwrap().len(), 1);
    assert!(f.results()[0].0);
    assert!(
        f.results()[0].1["message"]
            .as_str()
            .unwrap()
            .contains("authentication")
    );
}

#[test]
fn context_overflow_returns_an_error_without_invoking_or_rewriting_history() {
    let f = Fixture::new([]);
    *f.model.budget.lock().unwrap() = ash_core::ContextBudget::core_managed(
        ash_core::ContextTokenCount::new(64),
        ash_core::ContextTokenCount::new(16),
        ash_core::ContextTokenCount::new(8),
        ash_core::ContextCompactionLimit::ContextWindow,
    );
    let turn = f.start(
        TurnKind::Advisor,
        Some(AdvisorConfig::new(model("reviewer"))),
    );
    f.run(&turn);
    assert!(f.model.requests.lock().unwrap().is_empty());
    assert!(f.results()[0].0);
    assert!(
        f.results()[0].1["message"]
            .as_str()
            .unwrap()
            .contains("context")
    );
    assert!(
        f.threads
            .read_thread(&f.id)
            .unwrap()
            .context_checkpoints
            .is_empty()
    );
}

#[test]
fn interrupt_cancels_the_running_advisor_request() {
    use std::sync::atomic::Ordering;
    let f = Fixture::new([]);
    f.model.block.store(true, Ordering::SeqCst);
    let turn = f.start(
        TurnKind::Advisor,
        Some(AdvisorConfig::new(model("reviewer"))),
    );
    f.executor.start(&f.id, &turn).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while f.model.requests.lock().unwrap().is_empty() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    f.threads
        .interrupt_turn(
            &f.id,
            core_api::InterruptTurnRequest {
                command_id: CommandId::new("cancel").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: turn,
            },
        )
        .unwrap();
    while !f.model.cancelled.load(Ordering::SeqCst) {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(f.model.requests.lock().unwrap().len(), 1);
}
