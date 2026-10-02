use super::*;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use ash_core::CreateThreadRequest;
use ash_core::InMemoryThreadStore;
use ash_core::StartTurnRequest;
use ash_core::TurnExecutor;
use ash_protocol::AgentResponse;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::ResponseItem;
use ash_protocol::SessionId;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use ash_protocol::UserInputAnswer;
use core_api::ActionPolicyService;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::ResolveTurnInteractionRequest;
use core_api::SequenceExpectation;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

struct Fixture {
    threads: Arc<ThreadController>,
    thread: ThreadId,
    turn: TurnId,
    model: Arc<SwitchModel>,
    executor: TurnExecutor,
}

impl Fixture {
    fn new(from: CollaborationMode, to: CollaborationMode) -> Self {
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let thread = ThreadId::new("switch-thread").unwrap();
        threads
            .create_thread(CreateThreadRequest {
                execution_target: None,
                agent_id: ash_protocol::AgentId::new("switch-agent").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: SessionId::new("switch-session").unwrap(),
                thread_id: thread.clone(),
                title: "switch".into(),
            })
            .unwrap();
        let model = Arc::new(SwitchModel {
            mode: to,
            requests: Mutex::new(Vec::new()),
        });
        let executor = TurnExecutor::new(
            threads.clone(),
            model.clone(),
            Arc::new(SwitchModeToolService::new(threads.clone())),
            Arc::new(SwitchPolicy),
        );
        let turn = threads
            .start_turn(
                &thread,
                StartTurnRequest {
                    mode: from,
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS
                        .freeze()
                        .with_mode(&collaboration_mode_templates::instructions(from)),
                    command_id: CommandId::new("switch-start").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: "switch-policy".into(),
                    approval_mode: ApprovalMode::BypassPermissions,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: Some(executor.tool_profile_snapshot().unwrap()),
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: "investigate the requested change".into(),
                    }],
                },
            )
            .unwrap()
            .turn_id;
        Self {
            threads,
            thread,
            turn,
            model,
            executor,
        }
    }

    fn start(&self) {
        self.executor.start(&self.thread, &self.turn).unwrap();
    }

    fn wait(&self, status: TurnStatus) -> ash_core::ThreadSnapshot {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = self.threads.read_thread(&self.thread).unwrap();
            if snapshot.turns[0].status == status {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "Turn did not reach {status:?}: {:?}",
                snapshot.turns[0].status
            );
            std::thread::yield_now();
        }
    }

    fn respond(&self, mode: CollaborationMode) {
        let snapshot = self.wait(TurnStatus::WaitingForUserInput);
        assert_eq!(snapshot.turns[0].mode.is_analysis(), true);
        let interaction = snapshot.turns[0].pending_interaction.as_ref().unwrap();
        self.threads
            .resolve_turn_interaction(
                &self.thread,
                ResolveTurnInteractionRequest {
                    turn_id: self.turn.clone(),
                    command_id: CommandId::new("switch-answer").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    request_id: interaction.request_id.clone(),
                    response: AgentResponse::UserInput {
                        response: RequestUserInputResponse {
                            answers: BTreeMap::from([(
                                SWITCH_MODE_TOOL_NAME.into(),
                                UserInputAnswer {
                                    value: mode_id(mode),
                                },
                            )]),
                        },
                    },
                },
            )
            .unwrap();
    }
}

#[test]
fn switch_mode_reaches_the_next_model_request_and_committed_updates() {
    let fixture = Fixture::new(CollaborationMode::Agent, CollaborationMode::Plan);
    fixture.start();
    let snapshot = fixture.wait(TurnStatus::Completed);
    assert_eq!(snapshot.turns[0].mode, CollaborationMode::Plan);
    let requests = fixture.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        serde_json::to_string(&requests[0])
            .unwrap()
            .contains("# Collaboration mode: Agent")
    );
    let second = serde_json::to_string(&requests[1]).unwrap();
    assert!(second.contains("# Collaboration mode: Plan"));
    assert!(!second.contains("# Collaboration mode: Agent"));
    assert_eq!(
        requests[0].tools, requests[1].tools,
        "switching must not widen the frozen tool ceiling"
    );
    let updates = fixture
        .threads
        .thread_updates_after(&fixture.thread, 0)
        .unwrap();
    assert!(updates.iter().any(|update| matches!(
        &update.update,
        ash_protocol::ThreadUpdate::Committed {
            event: ash_protocol::ThreadEvent::TurnModeChanged {
                mode: CollaborationMode::Plan,
                ..
            }
        }
    )));
}

#[test]
fn leaving_analysis_requires_explicit_input_even_with_permission_bypass() {
    for from in [CollaborationMode::Plan, CollaborationMode::Ask] {
        for approved in [true, false] {
            let fixture = Fixture::new(from, CollaborationMode::Agent);
            fixture.start();
            fixture.respond(if approved {
                CollaborationMode::Agent
            } else {
                from
            });
            let snapshot = fixture.wait(TurnStatus::Completed);
            assert_eq!(
                snapshot.turns[0].mode,
                if approved {
                    CollaborationMode::Agent
                } else {
                    from
                }
            );
            assert!(snapshot.items.iter().any(|item| matches!(item, ash_protocol::ThreadItem::ToolResult { text, is_error: false, .. }
                if serde_json::from_str::<serde_json::Value>(text).unwrap()["changed"] == approved)));
        }
    }
}

#[test]
fn invalid_modes_and_empty_reasons_fail_before_execution() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let tools = SwitchModeToolService::new(threads);
    for args in [
        json!({"mode":"unknown","reason":"switch"}),
        json!({"mode":"plan","reason":" "}),
        json!({"mode":"plan","reason":"switch","extra":true}),
    ] {
        assert!(matches!(
            tools.prepare(&ToolCall {
                id: ToolCallId::new("invalid-switch").unwrap(),
                name: ToolName::new(SWITCH_MODE_TOOL_NAME).unwrap(),
                arguments: args
            }),
            Err(CoreError::InvalidInput(_))
        ));
    }
    assert_eq!(
        tools.definitions()[0].parameters["properties"]["mode"]["enum"],
        json!(CollaborationMode::ALL)
    );
}

struct SwitchModel {
    mode: CollaborationMode,
    requests: Mutex<Vec<ModelRequest>>,
}

impl ModelService for SwitchModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let mut requests = self.requests.lock().unwrap();
        let first = requests.is_empty();
        requests.push(request.clone());
        Ok(ModelResponse {
            output: if first {
                vec![ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new("switch-call").unwrap(),
                    name: ToolName::new(SWITCH_MODE_TOOL_NAME).unwrap(),
                    arguments: json!({"mode": self.mode, "reason": "Choose the approach for this task"}),
                })]
            } else {
                vec![ResponseItem::Text("done".into())]
            },
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

struct SwitchPolicy;
impl ActionPolicyService for SwitchPolicy {
    fn revision(&self) -> String {
        "switch-policy".into()
    }
    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::RunUnsandboxed {
            grant_id: GrantId::new("switch-test"),
        })
    }
}
