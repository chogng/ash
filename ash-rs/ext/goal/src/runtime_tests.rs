use async_utils::CancellationToken;
use protocol::CommandId;
use protocol::ContentPart;
use protocol::InputItem;
use protocol::ModelRequest;
use protocol::ModelResponse;
use protocol::ModelUsage;
use protocol::ResponseItem;
use protocol::SessionId;
use protocol::StopReason;
use protocol::ThreadId;
use protocol::ThreadItem;
use protocol::TurnId;
use protocol::TurnStatus;
use protocol::UserInput;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use core_api::CoreError;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::SequenceExpectation;
use ash_core::StartGoalTurnRequest;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::TurnExecutor;
struct ScriptedModel {
    responses: Mutex<VecDeque<Result<ModelResponse, CoreError>>>,
    requests: Mutex<Vec<ModelRequest>>,
}
fn executor(threads: Arc<ThreadController>, model: Arc<ScriptedModel>) -> TurnExecutor {
    let mut builder = extension_api::ExtensionRegistryBuilder::new();
    crate::install(&mut builder, &threads);
    let registry = Arc::new(builder.build());
    threads.install_extensions(registry.clone()).unwrap();
    TurnExecutor::without_tools(threads, model).with_extensions(registry)
}
#[test]
fn active_goal_starts_a_hidden_follow_up_until_the_budget_stops_it() {
    let (threads, thread_id, turn_id) = started_turn();
    threads
        .create_goal(&thread_id, "finish the requested task".into(), Some(15))
        .unwrap();
    let model = Arc::new(ScriptedModel::new([
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("first answer".into())],
            usage: Some(ModelUsage {
                input_tokens: Some(1),
                output_tokens: Some(0),
                cached_input_tokens: Some(0),
                cache_write_input_tokens: Some(0),
                reasoning_tokens: None,
            }),
            billing: None,
            stop_reason: StopReason::Completed,
        }),
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("final answer".into())],
            usage: Some(ModelUsage {
                input_tokens: Some(14),
                output_tokens: Some(0),
                cached_input_tokens: Some(0),
                cache_write_input_tokens: Some(0),
                reasoning_tokens: None,
            }),
            billing: None,
            stop_reason: StopReason::Completed,
        }),
    ]));

    let executor = executor(threads.clone(), model.clone());
    executor.start(&thread_id, &turn_id).unwrap();

    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = threads.read_thread(&thread_id).unwrap();
        if snapshot.turns.len() == 2 && snapshot.turns[1].status == TurnStatus::Completed {
            assert_eq!(model.requests().len(), 2);
            assert_eq!(
                snapshot
                    .items
                    .iter()
                    .filter(|item| matches!(item, ThreadItem::UserMessage { .. }))
                    .count(),
                1
            );
            let goal = snapshot.goal.unwrap();
            assert_eq!(goal.tokens_used, 15);
            assert_eq!(goal.status, protocol::ThreadGoalStatus::BudgetLimited);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "active Goal did not finish its hidden follow-up Turn: statuses={:?}, requests={}, goal={:?}",
            snapshot
                .turns
                .iter()
                .map(|turn| turn.status)
                .collect::<Vec<_>>(),
            model.requests().len(),
            snapshot.goal
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn review_turn_ignores_active_goal_instructions_and_does_not_continue_it() {
    let (threads, thread_id, turn_id) = started_review_turn();
    threads
        .create_goal(&thread_id, "goal text must not enter review".into(), None)
        .unwrap();
    let model = Arc::new(ScriptedModel::new([Ok(text_response("review complete"))]));

    executor(threads.clone(), model.clone())
        .start(&thread_id, &turn_id)
        .unwrap();

    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(snapshot.turns.len(), 1);
    assert_eq!(snapshot.goal.unwrap().tokens_used, 0);
    assert_eq!(model.requests().len(), 1);
    assert!(!request_contains(
        &model.requests()[0],
        "goal text must not enter review"
    ));
}

#[test]
fn recovered_active_goal_resumes_a_running_hidden_turn() {
    let (threads, thread_id, first_turn_id) = started_turn();
    threads
        .complete_turn(&thread_id, &first_turn_id, "first answer".into())
        .unwrap();
    threads
        .create_goal(&thread_id, "finish the requested task".into(), Some(1))
        .unwrap();
    let hidden_turn = threads
        .start_goal_turn(
            &thread_id,
            StartGoalTurnRequest {
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("recovered-goal-continuation").unwrap(),
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::AskPermissions,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
            },
        )
        .unwrap()
        .expect("active Goal should create a continuation")
        .turn_id;
    let model = Arc::new(ScriptedModel::new([Ok(ModelResponse {
        output: vec![ResponseItem::Text("recovered answer".into())],
        usage: Some(ModelUsage {
            input_tokens: Some(1),
            output_tokens: Some(0),
            cached_input_tokens: Some(0),
            cache_write_input_tokens: Some(0),
            reasoning_tokens: None,
        }),
        billing: None,
        stop_reason: StopReason::Completed,
    })]));
    let executor = executor(threads.clone(), model.clone());
    let session_ids = [SessionId::new("session").unwrap()]
        .into_iter()
        .collect::<BTreeSet<_>>();

    assert_eq!(
        executor
            .resume_recovered_extension_turns_in_sessions(&session_ids)
            .unwrap(),
        1
    );
    wait_for_turn_status(&threads, &thread_id, &hidden_turn, TurnStatus::Completed);
    let snapshot = threads.read_thread(&thread_id).unwrap();
    assert_eq!(model.requests().len(), 1);
    assert_eq!(snapshot.turns.len(), 2);
    assert_eq!(
        snapshot.goal.unwrap().status,
        protocol::ThreadGoalStatus::BudgetLimited
    );
}
impl ScriptedModel {
    fn new(responses: impl IntoIterator<Item = Result<ModelResponse, CoreError>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<ModelRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ModelService for ScriptedModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("script contains a response")
    }
}

fn started_turn() -> (Arc<ThreadController>, ThreadId, TurnId) {
    started_turn_with_tool_mode(protocol::ToolMode::Direct)
}

fn started_review_turn() -> (Arc<ThreadController>, ThreadId, TurnId) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("review-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("review-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "review".into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: protocol::TurnKind::Review,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-review").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::AskPermissions,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "review current changes".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    (threads, thread_id, turn_id)
}

fn started_turn_with_tool_mode(
    tool_mode: protocol::ToolMode,
) -> (Arc<ThreadController>, ThreadId, TurnId) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session").unwrap(),
            thread_id: thread_id.clone(),
            title: "test".into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: protocol::TurnKind::Coding,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::AskPermissions,
                tool_mode,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    (threads, thread_id, turn_id)
}

fn text_response(text: &str) -> ModelResponse {
    ModelResponse {
        output: vec![ResponseItem::Text(text.into())],
        usage: None,
        billing: None,
        stop_reason: StopReason::Completed,
    }
}

fn request_contains(request: &ModelRequest, expected: &str) -> bool {
    request.input.iter().any(|input| match input {
        InputItem::Message(message) => message
            .content
            .iter()
            .any(|content| matches!(content, ContentPart::Text(text) if text.contains(expected))),
        InputItem::ToolResult(_) => false,
    })
}

fn wait_for_turn_status(
    threads: &ThreadController,
    thread_id: &ThreadId,
    turn_id: &protocol::TurnId,
    expected: TurnStatus,
) {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let snapshot = threads.read_thread(thread_id).unwrap();
        if snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .is_some_and(|turn| turn.status == expected)
        {
            return;
        }
        assert!(Instant::now() < deadline, "Turn did not reach {expected:?}");
        thread::sleep(Duration::from_millis(1));
    }
}
