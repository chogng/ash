use super::*;
use ash_core::AgentTreeLimits;
use ash_core::InMemoryThreadStore;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_core::TurnExecutionBackend;
use async_utils::CancellationSource;
use core_api::CoreError;
use core_api::SequenceExpectation;
use core_api::StartThreadRequest;
use protocol::AgentCapabilityScope;
use protocol::AgentRoleSnapshot;
use protocol::CommandId;
use protocol::ToolCallId;
use protocol::UserInput;

#[test]
fn exposes_only_the_three_agent_coordination_tools() {
    let service = service();

    let names = service
        .definitions()
        .into_iter()
        .map(|definition| definition.name.to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec![
            SPAWN_AGENT_TOOL_NAME,
            SEND_AGENT_MESSAGE_TOOL_NAME,
            WAIT_AGENT_TOOL_NAME,
        ]
    );
}

#[test]
fn spawn_agent_describes_the_built_in_issue_role() {
    let definition = service()
        .definitions()
        .into_iter()
        .find(|definition| definition.name.as_str() == SPAWN_AGENT_TOOL_NAME)
        .unwrap();
    let description = definition.parameters["properties"]["agent"]["description"]
        .as_str()
        .unwrap();

    assert!(description.contains("issue: Coordinates one or more GitHub issues"));
    assert!(!description.contains("develop-intent"));
    assert!(!description.contains("intent-researcher"));
}

#[test]
fn prepares_agent_coordination_as_a_builtin_system_operation() {
    let service = service();
    let call = ToolCall {
        id: ToolCallId::new("spawn-call").unwrap(),
        name: ToolName::new(SPAWN_AGENT_TOOL_NAME).unwrap(),
        arguments: json!({"task": "review the change", "name": null}),
    };

    let review = service.prepare(&call).unwrap();

    assert_eq!(review.action().kind(), &ActionKind::SystemOperation);
    assert_eq!(review.provenance().source(), &ActionSource::BuiltInTool);
    assert_eq!(review.provenance().source_id(), SPAWN_AGENT_TOOL_NAME);
    assert!(matches!(
        review.sandbox(),
        SandboxCompatibility::NotApplicable { .. }
    ));
}

#[test]
fn refuses_execution_without_durable_turn_identity() {
    let service = service();
    let call = ToolCall {
        id: ToolCallId::new("spawn-call").unwrap(),
        name: ToolName::new(SPAWN_AGENT_TOOL_NAME).unwrap(),
        arguments: json!({"task": "review the change", "name": null}),
    };

    let error = service
        .execute(
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: action_policy::GrantId::new("test"),
            },
            &CancellationSource::new().token(),
        )
        .unwrap_err();

    assert!(error.to_string().contains("durable execution facts"));
}

#[test]
fn spawn_tool_uses_frozen_intent_parent_to_launch_private_investigator() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let coordinator = Arc::new(MultiAgentCoordinator::new(
        threads.clone(),
        AgentTreeLimits::default(),
    ));
    let tools = [
        "read_file",
        "grep",
        "glob",
        "board_read",
        "board_write",
        "spawn_agent",
        "send_agent_message",
        "wait_agent",
        "web_search",
    ]
    .into_iter()
    .map(|name| ToolName::new(name).unwrap())
    .collect::<Vec<_>>();
    let role = crate::resolve_launched_agent(
        &protocol::AgentRoleSelection::Exact {
            source: protocol::AgentRoleSource::BuiltIn,
            name: "develop-intent".into(),
        },
        None,
        tools.clone(),
        &[],
        &[agent_roles::built_in_roles()],
        &[],
        crate::AgentLaunch::Workflow,
    )
    .unwrap();
    let parent = threads
        .start_thread(
            &ash_core::NoThreadWorktreeBinder,
            StartThreadRequest {
                agent_id: None,
                agent: Some(protocol::AgentConfiguration {
                    role: role.role,
                    capability_scope: role.capability_scope,
                    base_instructions: Some(prompts::AGENT_INSTRUCTIONS.freeze()),
                }),
                command_id: CommandId::new("intent-parent").unwrap(),
                title: "Intent".into(),
            },
        )
        .unwrap();
    let turn = threads
        .start_turn(
            &parent.thread_id,
            StartTurnRequest {
                command_id: CommandId::new("intent-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                advisor: None,
                kind: protocol::TurnKind::Coding,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::AskPermissions,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "Investigate project facts".into(),
                }],
            },
        )
        .unwrap();
    let mut service = MultiAgentToolService::new(
        coordinator,
        threads.clone(),
        Arc::new(NoopTurnBackend),
        ActionPolicyRevision::new("test-policy-v1"),
    );
    for name in tools {
        if !service.definitions.iter().any(|tool| tool.name == name) {
            service.definitions.push(definition(
                name.as_str(),
                "Read-only fixture tool",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ));
        }
    }
    let executor = ash_core::TurnExecutor::new(
        threads.clone(),
        Arc::new(PrivateSpawnModel),
        Arc::new(service),
        Arc::new(CoordinationPolicy),
    );
    executor.start(&parent.thread_id, &turn.turn_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = threads.read_thread(&parent.thread_id).unwrap();
        let status = snapshot.turns.last().unwrap().status;
        if status == protocol::TurnStatus::Completed {
            break;
        }
        assert_ne!(status, protocol::TurnStatus::Failed, "{snapshot:?}");
        assert!(Instant::now() < deadline, "private spawn did not finish");
        std::thread::yield_now();
    }
    let parent = threads.read_thread(&parent.thread_id).unwrap();
    assert_eq!(parent.delegations.len(), 1);
    let child = threads
        .read_thread(
            parent
                .delegations
                .values()
                .next()
                .unwrap()
                .child_thread_id
                .as_ref()
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        child
            .agent_configuration()
            .unwrap()
            .role
            .as_ref()
            .unwrap()
            .name,
        "intent-project-investigator"
    );
    assert!(
        child
            .agent_configuration()
            .unwrap()
            .capability_scope
            .delegation_tools
            .is_empty()
    );
}

#[test]
fn spawn_context_arguments_cover_selected_and_forked_modes() {
    let selected = spawn_context(Some(SpawnContextArguments {
        mode: SpawnContextMode::Selected,
        count: None,
        sources: Some(vec![SpawnContextSourceArguments {
            kind: SpawnContextSourceKind::Item,
            source_thread_id: "parent".into(),
            source_sequence: 7,
            item_id: Some("item-1".into()),
            checkpoint_id: None,
        }]),
    }))
    .unwrap();
    assert!(matches!(
        selected,
        AgentContextMode::Selected { sources } if sources.len() == 1
    ));
    let forked = spawn_context(Some(SpawnContextArguments {
        mode: SpawnContextMode::LastTurns,
        count: Some(3),
        sources: None,
    }))
    .unwrap();
    assert!(matches!(
        forked,
        AgentContextMode::ForkedPrefix {
            selection: ForkedAgentContext::LastTurns { count: 3 }
        }
    ));
}

#[test]
fn wait_arguments_map_to_durable_all_any_and_quorum_policies() {
    let all = wait_join_policy(&WaitArguments {
        delegation_id: Some("one".into()),
        delegation_ids: None,
        policy: Some(WaitPolicy::All),
        quorum: None,
        timeout_ms: None,
    })
    .unwrap();
    assert_eq!(all.0.unwrap().len(), 1);
    assert_eq!(all.1, AgentJoinPolicy::All);
    let any = wait_join_policy(&WaitArguments {
        delegation_id: None,
        delegation_ids: Some(vec!["one".into(), "two".into()]),
        policy: Some(WaitPolicy::Any),
        quorum: None,
        timeout_ms: Some(0),
    })
    .unwrap();
    assert_eq!(any.1, AgentJoinPolicy::Any);
    let quorum = wait_join_policy(&WaitArguments {
        delegation_id: None,
        delegation_ids: None,
        policy: Some(WaitPolicy::Quorum),
        quorum: Some(2),
        timeout_ms: None,
    })
    .unwrap();
    assert_eq!(quorum.1, AgentJoinPolicy::Quorum { count: 2 });
}

#[test]
fn wait_timeout_returns_a_durable_waiting_join_without_losing_the_delegation() {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let coordinator = Arc::new(MultiAgentCoordinator::new(
        Arc::clone(&threads),
        AgentTreeLimits::default(),
    ));
    let parent = threads
        .start_thread(
            &ash_core::NoThreadWorktreeBinder,
            StartThreadRequest {
                agent_id: None,
                agent: None,
                command_id: CommandId::new("timeout-parent").unwrap(),
                title: "parent".into(),
            },
        )
        .unwrap();
    let parent_turn = threads
        .start_turn(
            &parent.thread_id,
            StartTurnRequest {
                advisor: None,
                kind: protocol::TurnKind::Coding,
                instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("timeout-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: protocol::ApprovalMode::AskPermissions,
                tool_mode: protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "delegate".into(),
                }],
            },
        )
        .unwrap();
    let spawned = coordinator
        .spawn(SpawnAgentRequest {
            base_instructions: prompts::AGENT_INSTRUCTIONS.freeze(),
            delegation_id: DelegationId::new("timeout-child").unwrap(),
            session_id: parent.session_id.clone(),
            parent_thread_id: parent.thread_id.clone(),
            parent_turn_id: parent_turn.turn_id,
            task: DelegatedTask {
                title: "child".into(),
                instructions: "keep working".into(),
            },
            role: Some(AgentRoleSnapshot {
                name: "general".into(),
                instructions: "Return one answer.".into(),
                model: None,
                definition: None,
            }),
            inheritance: AgentContextMode::Fresh,
            policy_ceiling: DelegatedPolicyCeiling {
                policy_revision: "test-policy-v1".into(),
            },
            capability_scope: AgentCapabilityScope {
                tools: Vec::new(),
                delegation_tools: Vec::new(),
                skills: Vec::new(),
            },
        })
        .unwrap();
    let service = MultiAgentToolService::new(
        Arc::clone(&coordinator),
        Arc::clone(&threads),
        Arc::new(NoopTurnBackend),
        ActionPolicyRevision::new("test-policy-v1"),
    );

    let output = service
        .wait_for_join(
            &parent.thread_id,
            AgentJoinId::new("timeout-join").unwrap(),
            Some(vec![spawned.delegation_id.clone()]),
            AgentJoinPolicy::All,
            Duration::ZERO,
            &CancellationSource::new().token(),
        )
        .unwrap();

    let ToolExecutionOutput::Success(output) = output else {
        panic!("wait timeout must return a successful waiting projection")
    };
    let output: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(output["status"], "waiting");
    let parent = threads.read_thread(&parent.thread_id).unwrap();
    assert_eq!(parent.agent_joins.len(), 1);
    assert_eq!(
        parent.agent_joins.values().next().unwrap().status,
        AgentJoinStatus::Waiting
    );

    let request_id = protocol::RequestId::new("child-question").unwrap();
    threads
        .request_turn_interaction(
            &spawned.child_thread_id,
            &spawned.child_turn_id,
            ash_core::RequestTurnInteraction {
                request_id: request_id.clone(),
                item_id: None,
                deadline: None,
                request: protocol::AgentRequest::UserInput {
                    request: protocol::RequestUserInput {
                        questions: vec![protocol::UserInputQuestion {
                            id: "answer".into(),
                            header: "Choice".into(),
                            question: "Which target?".into(),
                            options: Vec::new(),
                            allow_free_form: true,
                        }],
                    },
                },
            },
        )
        .unwrap();
    let ToolExecutionOutput::Success(attention) = service
        .wait_for_join(
            &parent.thread_id,
            AgentJoinId::new("timeout-join").unwrap(),
            Some(vec![spawned.delegation_id.clone()]),
            AgentJoinPolicy::All,
            Duration::from_secs(5),
            &CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("child input should return attention")
    };
    let attention: Value = serde_json::from_str(&attention).unwrap();
    assert_eq!(attention["reason"], "needs_input");
    assert_eq!(attention["attention"][0]["request_id"], "child-question");
    threads
        .resolve_turn_interaction(
            &spawned.child_thread_id,
            core_api::ResolveTurnInteractionRequest {
                command_id: CommandId::new("answer-child").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                turn_id: spawned.child_turn_id.clone(),
                request_id,
                response: protocol::AgentResponse::UserInput {
                    response: protocol::RequestUserInputResponse {
                        answers: std::collections::BTreeMap::from([(
                            "answer".into(),
                            protocol::UserInputAnswer {
                                value: "the selected target".into(),
                            },
                        )]),
                    },
                },
            },
        )
        .unwrap();

    // Resume the same durable join. The worker must remain inside one wait until a
    // committed child completion arrives, regardless of intermediate child output.
    std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::channel();
        let service = &service;
        let parent = &parent;
        let spawned = &spawned;
        scope.spawn(move || {
            let result = service.wait_for_join(
                &parent.thread_id,
                AgentJoinId::new("timeout-join").unwrap(),
                Some(vec![spawned.delegation_id.clone()]),
                AgentJoinPolicy::All,
                Duration::from_secs(5),
                &CancellationSource::new().token(),
            );
            tx.send(result).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        threads
            .complete_turn(
                &spawned.child_thread_id,
                &spawned.child_turn_id,
                "child finished".into(),
            )
            .unwrap();
        let ToolExecutionOutput::Success(result) =
            rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap()
        else {
            panic!("join should return completed results")
        };
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["status"], "satisfied");
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
    });
}

fn service() -> MultiAgentToolService {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    MultiAgentToolService::new(
        Arc::new(MultiAgentCoordinator::new(
            Arc::clone(&threads),
            AgentTreeLimits::default(),
        )),
        threads,
        Arc::new(NoopTurnBackend),
        ActionPolicyRevision::new("test-policy-v1"),
    )
}

struct NoopTurnBackend;

struct PrivateSpawnModel;
impl core_api::ModelService for PrivateSpawnModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &protocol::ModelRequest,
        _: &CancellationToken,
    ) -> Result<protocol::ModelResponse, CoreError> {
        let output = if request
            .input
            .iter()
            .any(|item| matches!(item, protocol::InputItem::ToolResult(_)))
        {
            protocol::ResponseItem::Text("Investigation delegated".into())
        } else {
            protocol::ResponseItem::ToolCall(ToolCall {
                id: ToolCallId::new("private-spawn").unwrap(),
                name: ToolName::new("spawn_agent").unwrap(),
                arguments: json!({"task":"Read the current module", "name":null, "agent":{"type":"exact","source":{"type":"builtIn"},"name":"intent-project-investigator"}, "context":null}),
            })
        };
        Ok(protocol::ModelResponse {
            output: vec![output],
            usage: None,
            billing: None,
            stop_reason: protocol::StopReason::Completed,
        })
    }
}

struct CoordinationPolicy;
impl core_api::ActionPolicyService for CoordinationPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }
    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<action_policy::ExecutionDecision, CoreError> {
        Ok(action_policy::ExecutionDecision::RunUnsandboxed {
            grant_id: action_policy::GrantId::new("coordination-test"),
        })
    }
}

impl TurnExecutionBackend for NoopTurnBackend {
    fn start(&self, _: &protocol::ThreadId, _: &protocol::TurnId) -> Result<(), CoreError> {
        Ok(())
    }

    fn resume(&self, _: &protocol::ThreadId, _: &protocol::TurnId) -> Result<(), CoreError> {
        Ok(())
    }
}
