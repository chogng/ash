use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::StartGoalTurnRequest;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::ThreadEventBatch;
use ash_core::ThreadStore;
use ash_core::TurnExecutor;
use async_utils::CancellationToken;
use core_api::CoreError;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::SequenceExpectation;
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
    let (threads, thread_id, turn_id) = started_turn_with_options(
        protocol::CollaborationMode::Agent,
        protocol::ToolMode::Direct,
        Some(protocol::ReasoningEffort::High),
    );
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
                snapshot.turns[1].reasoning_effort,
                Some(protocol::ReasoningEffort::High)
            );
            assert_eq!(
                model.requests()[1].reasoning.as_ref().unwrap().effort,
                protocol::ReasoningEffort::High
            );
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
fn goal_continuation_resolves_session_advisor_inheritance_without_affecting_other_sessions() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let preference: protocol::AdvisorConfig = serde_json::from_value(serde_json::json!({
        "enabled": true, "maxCalls": 7, "maxOutputTokens": 8192,
        "reasoningEffort": "low"
    }))
    .unwrap();
    let model = Arc::new(ScriptedModel::new((0..5).map(|_| {
        let mut response = text_response("done");
        response.usage = Some(ModelUsage {
            input_tokens: Some(1),
            output_tokens: Some(0),
            cached_input_tokens: Some(0),
            cache_write_input_tokens: Some(0),
            reasoning_tokens: None,
        });
        Ok(response)
    })));
    let executor = executor(threads.clone(), model.clone());

    for (name, selection) in [
        (
            "explicit-chat-model",
            Some(protocol::ModelRef::new(
                protocol::ProviderId::new("test").unwrap(),
                protocol::ModelId::new("chat").unwrap(),
            )),
        ),
        ("no-chat-model", None),
    ] {
        let (thread_id, turn_id) =
            start_session_turn(&threads, name, selection.clone(), Some(preference.clone()));
        // Session preferences remain unresolved, unlike the settings frozen for each Turn.
        let advisor_selection = protocol::AdvisorSelection::Model {
            config: preference.clone(),
        };
        threads
            .configure_advisor(
                &thread_id,
                CommandId::new("inherit-advisor").unwrap(),
                SequenceExpectation::Any,
                advisor_selection.clone(),
            )
            .unwrap();
        threads
            .create_goal(&thread_id, "finish the requested task".into(), Some(2))
            .unwrap();
        executor.start(&thread_id, &turn_id).unwrap();

        let deadline = Instant::now() + Duration::from_secs(1);
        let snapshot = loop {
            let snapshot = threads.read_thread(&thread_id).unwrap();
            if snapshot.turns.len() == 2 && snapshot.turns[1].status == TurnStatus::Completed {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "Goal did not continue: statuses={:?}, goal={:?}",
                snapshot
                    .turns
                    .iter()
                    .map(|turn| turn.status)
                    .collect::<Vec<_>>(),
                snapshot.goal
            );
            thread::sleep(Duration::from_millis(1));
        };
        assert_eq!(snapshot.advisor, advisor_selection);
        assert_eq!(
            snapshot.goal.unwrap().status,
            protocol::ThreadGoalStatus::BudgetLimited
        );
        let expected = selection.map(|model| protocol::AdvisorConfig {
            model: Some(model),
            reasoning_effort: Some(protocol::ReasoningEffort::High),
            ..preference.clone()
        });
        for turn in &snapshot.turns {
            assert_eq!(turn.advisor, expected);
        }
        for command in &snapshot.commands {
            if let protocol::ThreadCommand::StartTurn { advisor, .. } = &command.receipt.command {
                assert_eq!(advisor, &expected);
            }
        }
    }

    let (thread_id, turn_id) = start_session_turn(&threads, "other-session", None, None);
    executor.start(&thread_id, &turn_id).unwrap();
    wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);
    assert_eq!(model.requests().len(), 5);
}

#[test]
fn recovered_unresolved_advisor_fails_durably_and_other_sessions_still_execute() {
    let source_store = Arc::new(InMemoryThreadStore::default());
    let source = ThreadController::with_store(source_store.clone());
    let (thread_id, first_turn_id) = start_session_turn(&source, "legacy-goal", None, None);
    source
        .complete_turn(&thread_id, &first_turn_id, "first answer".into())
        .unwrap();
    source
        .create_goal(&thread_id, "finish the requested task".into(), None)
        .unwrap();
    let hidden_turn = source
        .start_goal_turn(
            &thread_id,
            StartGoalTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("legacy-continuation").unwrap(),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::Manual,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
            },
        )
        .unwrap()
        .unwrap()
        .turn_id;
    let mut events = source_store.events();
    let preference = serde_json::from_value(serde_json::json!({"enabled":true})).unwrap();
    // Recreate the journal written before Goal admission resolved Advisor inheritance.
    let accepted = events
        .iter_mut()
        .find(|event| matches!(&event.event, protocol::ThreadEvent::TurnAccepted { turn_id, .. } if turn_id == &hidden_turn))
        .unwrap();
    let protocol::ThreadEvent::TurnAccepted { advisor, .. } = &mut accepted.event else {
        unreachable!();
    };
    *advisor = Some(preference);
    let protocol::ThreadCommand::StartTurn {
        advisor: command_advisor,
        ..
    } = &mut accepted.command.as_mut().unwrap().command
    else {
        unreachable!();
    };
    *command_advisor = advisor.clone();
    let store = Arc::new(InMemoryThreadStore::default());
    store
        .append_batch(&ThreadEventBatch {
            history_index: None,
            history_prefixes: Vec::new(),
            batch_id: "legacy-journal".into(),
            thread_id: thread_id.clone(),
            expected_sequence: 0,
            events,
            catalog: source.thread_catalog_record(&thread_id).unwrap(),
        })
        .unwrap();
    let threads = Arc::new(ThreadController::with_store(store.clone()));
    let loaded = threads.read_thread(&thread_id).unwrap();
    assert_eq!(loaded.turns.last().unwrap().status, TurnStatus::Running);
    let model = Arc::new(ScriptedModel::new([Ok(text_response(
        "other session answer",
    ))]));
    let executor = executor(threads.clone(), model.clone());
    let sessions = [loaded.session_id].into_iter().collect();
    assert!(matches!(
        executor.resume_recovered_extension_turns_in_sessions(&sessions),
        Err(CoreError::Execution(message)) if message == "Turn Advisor configuration has no frozen model"
    ));
    let failed = threads.read_thread(&thread_id).unwrap();
    assert_eq!(failed.turns.last().unwrap().status, TurnStatus::Failed);
    assert_eq!(
        failed.goal.unwrap().status,
        protocol::ThreadGoalStatus::Blocked
    );
    assert!(model.requests().is_empty());
    assert_eq!(
        executor
            .resume_recovered_extension_turns_in_sessions(&sessions)
            .unwrap(),
        0
    );
    assert_eq!(
        ThreadController::with_store(store)
            .read_thread(&thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Failed
    );

    let (other_thread, other_turn) = start_session_turn(&threads, "healthy-session", None, None);
    executor.start(&other_thread, &other_turn).unwrap();
    wait_for_turn_status(&threads, &other_thread, &other_turn, TurnStatus::Completed);
    assert_eq!(model.requests().len(), 1);
}

fn start_session_turn(
    threads: &ThreadController,
    name: &str,
    model: Option<protocol::ModelRef>,
    advisor: Option<protocol::AdvisorConfig>,
) -> (ThreadId, TurnId) {
    let thread_id = ThreadId::new(name).unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: protocol::AgentId::new(format!("agent-{name}")).unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new(name).unwrap(),
            thread_id: thread_id.clone(),
            title: name.into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor,
                kind: protocol::TurnKind::Coding,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model,
                reasoning_effort: Some(protocol::ReasoningEffort::High),
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::Manual,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap()
        .turn_id;
    (thread_id, turn_id)
}

#[test]
fn goal_continuation_preserves_execution_modes_and_waits_after_analysis_modes() {
    use extension_api::ContinuationContributor;
    use protocol::CollaborationMode;

    for mode in [
        CollaborationMode::Agent,
        CollaborationMode::Plan,
        CollaborationMode::Debug,
        CollaborationMode::Multitask,
        CollaborationMode::Ask,
    ] {
        let (threads, thread_id, turn_id) =
            started_turn_with_options(mode, protocol::ToolMode::Direct, None);
        threads
            .create_goal(&thread_id, "finish the requested task".into(), None)
            .unwrap();
        threads
            .complete_turn(&thread_id, &turn_id, "answer complete".into())
            .unwrap();
        let extension = crate::runtime::GoalExtension::new(&threads);
        let next = extension.next_turn(&thread_id, &turn_id).unwrap();

        if matches!(mode, CollaborationMode::Plan | CollaborationMode::Ask) {
            assert!(next.is_none(), "{mode:?} must wait for the user");
            assert!(
                ContinuationContributor::recover(
                    &extension,
                    &[SessionId::new("session").unwrap()].into_iter().collect(),
                )
                .unwrap()
                .is_empty(),
                "recovery must also wait after {mode:?}"
            );
            let snapshot = threads.read_thread(&thread_id).unwrap();
            assert_eq!(snapshot.turns.len(), 1);
            assert_eq!(
                snapshot.goal.unwrap().status,
                protocol::ThreadGoalStatus::Active
            );
        } else {
            let next = next.expect("execution modes continue the active Goal");
            let snapshot = threads.read_thread(&thread_id).unwrap();
            let next_turn = snapshot
                .turns
                .iter()
                .find(|turn| turn.turn_id == next.turn_id)
                .unwrap();
            assert_eq!(next_turn.mode, mode);
            assert!(extension.next_turn(&thread_id, &turn_id).unwrap().is_none());
        }
    }
}

#[test]
fn analysis_modes_do_not_receive_active_goal_execution_instructions() {
    for mode in [
        protocol::CollaborationMode::Plan,
        protocol::CollaborationMode::Ask,
    ] {
        let (threads, thread_id, turn_id) =
            started_turn_with_options(mode, protocol::ToolMode::Direct, None);
        threads
            .create_goal(
                &thread_id,
                "active goal must not override this analysis".into(),
                None,
            )
            .unwrap();
        let model = Arc::new(ScriptedModel::new([Ok(text_response("analysis complete"))]));
        executor(threads.clone(), model.clone())
            .start(&thread_id, &turn_id)
            .unwrap();
        wait_for_turn_status(&threads, &thread_id, &turn_id, TurnStatus::Completed);
        assert_eq!(model.requests().len(), 1);
        assert!(!request_contains(
            &model.requests()[0],
            "active goal must not override this analysis"
        ));
        let extension = crate::runtime::GoalExtension::new(&threads);
        assert!(
            extension_api::ContinuationContributor::next_turn(&extension, &thread_id, &turn_id)
                .unwrap()
                .is_none()
        );
        let snapshot = threads.read_thread(&thread_id).unwrap();
        assert_eq!(snapshot.turns.len(), 1);
        assert_eq!(
            snapshot.goal.unwrap().status,
            protocol::ThreadGoalStatus::Active
        );
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
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("recovered-goal-continuation").unwrap(),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::Manual,
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
    started_turn_with_options(
        protocol::CollaborationMode::Agent,
        protocol::ToolMode::Direct,
        None,
    )
}

fn started_review_turn() -> (Arc<ThreadController>, ThreadId, TurnId) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("review-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
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
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: protocol::TurnKind::Review,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-review").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::Manual,
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

fn started_turn_with_options(
    mode: protocol::CollaborationMode,
    tool_mode: protocol::ToolMode,
    reasoning_effort: Option<protocol::ReasoningEffort>,
) -> (Arc<ThreadController>, ThreadId, TurnId) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let thread_id = ThreadId::new("thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
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
                context_policy: Default::default(),
                mode,
                advisor: None,
                kind: protocol::TurnKind::Coding,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                reasoning_effort,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::Manual,
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
        InputItem::ToolResult(_) | InputItem::Reasoning(_) => false,
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
