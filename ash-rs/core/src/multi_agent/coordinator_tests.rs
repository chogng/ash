use super::CompleteDelegationRequest;
use super::JoinAgentsRequest;
use super::MultiAgentCoordinator;
use super::SendAgentMessageRequest;
use super::SpawnAgentRequest;
use super::build_context_seed;
use crate::AgentCommandDisposition;
use crate::AgentTreeLimits;
use crate::ContextBudget;
use crate::HarnessContext;
use crate::InMemoryThreadStore;
use crate::SequenceExpectation;
use crate::StartThreadRequest;
use crate::StartTurnRequest;
use crate::ThreadController;
use crate::ToolExecutionFacts;
use crate::context::ModelInvocationPreparation;
use crate::project_agent_tree;
use crate::thread_controller::PrepareModelInvocationRequest;
use ash_protocol::AgentCapabilityScope;
use ash_protocol::AgentContextMode;
use ash_protocol::AgentContextSource;
use ash_protocol::AgentJoin;
use ash_protocol::AgentJoinId;
use ash_protocol::AgentJoinPolicy;
use ash_protocol::AgentJoinStatus;
use ash_protocol::AgentMessageId;
use ash_protocol::AgentMessageProvenance;
use ash_protocol::AgentRoleSnapshot;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_protocol::DelegatedPolicyCeiling;
use ash_protocol::DelegatedTask;
use ash_protocol::DelegationId;
use ash_protocol::DelegationResult;
use ash_protocol::DelegationResultDigest;
use ash_protocol::DelegationResultStatus;
use ash_protocol::ForkedAgentContext;
use ash_protocol::FrozenSkillActivation;
use ash_protocol::SessionId;
use ash_protocol::SkillActivationReason;
use ash_protocol::SkillId;
use ash_protocol::SkillName;
use ash_protocol::SkillRef;
use ash_protocol::SkillSourceId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadSequenceRange;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolName;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use std::sync::Arc;

struct Fixture {
    threads: Arc<ThreadController>,
    coordinator: MultiAgentCoordinator,
    session_id: SessionId,
    parent_thread_id: ThreadId,
    parent_turn_id: TurnId,
}

struct FixedSkillActivation(FrozenSkillActivation);

impl ash_extension_api::SkillActivationContributor for FixedSkillActivation {
    fn contribute(
        &self,
        _: ash_extension_api::SkillActivationContext<'_>,
    ) -> Result<Vec<FrozenSkillActivation>, ash_extension_api::ExtensionError> {
        Ok(vec![self.0.clone()])
    }
}

#[test]
fn spawn_creates_seeded_child_thread_and_initial_turn_idempotently() {
    let fixture = fixture();
    let first = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();
    let replayed = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();

    assert_eq!(first.child_thread_id, replayed.child_thread_id);
    assert_eq!(first.child_turn_id, replayed.child_turn_id);
    assert_eq!(first.disposition, AgentCommandDisposition::Committed);
    assert_eq!(replayed.disposition, AgentCommandDisposition::Replayed);
    assert_eq!(first.context_seed.parent_sequence, 4);

    let child = fixture.threads.read_thread(&first.child_thread_id).unwrap();
    assert_eq!(
        child.parent_thread_id,
        Some(fixture.parent_thread_id.clone())
    );

    let child = fixture.threads.read_thread(&first.child_thread_id).unwrap();
    assert_eq!(child.agent_context_seed, Some(first.context_seed));
    assert_eq!(child.turns.len(), 1);
    assert_eq!(child.turns[0].activated_skills, vec![test_activation()]);
    let ModelInvocationPreparation::Ready(invocation) = fixture
        .threads
        .prepare_model_invocation(
            &first.child_thread_id,
            PrepareModelInvocationRequest {
                turn_id: &first.child_turn_id,
                harness_context: &HarnessContext::default(),
                extension_fragments: Vec::new(),
                evidence: Vec::new(),
                tools: vec![tool_definition("allowed"), tool_definition("blocked")],
                budget: ContextBudget::provider_managed(),
            },
        )
        .unwrap()
    else {
        panic!("provider-managed context should be ready")
    };
    assert_eq!(
        invocation
            .context()
            .tools()
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["allowed"]
    );
    let facts = ToolExecutionFacts::for_turn(
        &child,
        &first.child_turn_id,
        [
            ToolName::new("allowed").unwrap(),
            ToolName::new("blocked").unwrap(),
            ToolName::new("delegated").unwrap(),
        ],
    )
    .unwrap();
    assert_eq!(
        facts
            .available_tools()
            .map(ToolName::as_str)
            .collect::<Vec<_>>(),
        vec!["allowed"]
    );
    assert_eq!(
        facts
            .delegation_tools()
            .map(ToolName::as_str)
            .collect::<Vec<_>>(),
        vec!["delegated"]
    );
    assert!(child.items.iter().any(|item| {
        matches!(item, ThreadItem::UserMessage { text, .. } if text == "Review the change")
    }));
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let tree = project_agent_tree(&[parent, child]);
    assert_eq!(tree.roots.len(), 1);
    assert_eq!(tree.roots[0].thread_id, fixture.parent_thread_id);
    assert_eq!(tree.roots[0].children[0].thread_id, first.child_thread_id);
}

#[test]
fn code_mode_agent_scope_keeps_controls_and_limits_nested_tools() {
    let fixture = fixture_with_tool_mode(ash_protocol::ToolMode::CodeModeOnly);
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let parent_facts = ToolExecutionFacts::for_turn(
        &parent,
        &fixture.parent_turn_id,
        [
            ToolName::new("allowed").unwrap(),
            ToolName::new("blocked").unwrap(),
            ToolName::new("delegated").unwrap(),
        ],
    )
    .unwrap();
    assert_eq!(
        parent_facts
            .available_tools()
            .map(ToolName::as_str)
            .collect::<Vec<_>>(),
        vec!["allowed", "blocked", "delegated", "exec", "wait"]
    );
    assert_eq!(
        parent_facts
            .delegation_tools()
            .map(ToolName::as_str)
            .collect::<Vec<_>>(),
        vec!["allowed", "blocked", "delegated", "exec", "wait"]
    );

    let mut request = spawn_request(&fixture);
    request.capability_scope.tools.extend([
        ToolName::new("exec").unwrap(),
        ToolName::new("wait").unwrap(),
    ]);
    let spawned = fixture.coordinator.spawn(request).unwrap();
    let child = fixture
        .threads
        .read_thread(&spawned.child_thread_id)
        .unwrap();
    let ModelInvocationPreparation::Ready(invocation) = fixture
        .threads
        .prepare_model_invocation(
            &spawned.child_thread_id,
            PrepareModelInvocationRequest {
                turn_id: &spawned.child_turn_id,
                harness_context: &HarnessContext::default(),
                extension_fragments: Vec::new(),
                evidence: Vec::new(),
                tools: vec![
                    tool_definition("exec"),
                    tool_definition("wait"),
                    tool_definition("blocked"),
                ],
                budget: ContextBudget::provider_managed(),
            },
        )
        .unwrap()
    else {
        panic!("provider-managed context should be ready")
    };
    assert_eq!(
        invocation
            .context()
            .tools()
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["exec", "wait"]
    );
    let child_facts = ToolExecutionFacts::for_turn(
        &child,
        &spawned.child_turn_id,
        [
            ToolName::new("allowed").unwrap(),
            ToolName::new("blocked").unwrap(),
            ToolName::new("delegated").unwrap(),
        ],
    )
    .unwrap();
    assert_eq!(
        child_facts
            .available_tools()
            .map(ToolName::as_str)
            .collect::<Vec<_>>(),
        vec!["allowed", "exec", "wait"]
    );
    assert_eq!(
        child_facts
            .delegation_tools()
            .map(ToolName::as_str)
            .collect::<Vec<_>>(),
        vec!["delegated"]
    );
}

#[test]
fn selected_and_forked_context_are_materialized_into_the_immutable_child_seed() {
    let fixture = fixture();
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let item_id = parent.items[0].item_id().clone();
    let mut selected = spawn_request_with_id(&fixture, "delegation-selected");
    selected.inheritance = AgentContextMode::Selected {
        sources: vec![AgentContextSource::Item {
            source_thread_id: fixture.parent_thread_id.clone(),
            source_sequence: parent.sequence,
            item_id,
        }],
    };
    let selected = fixture.coordinator.spawn(selected).unwrap();
    assert_eq!(selected.context_seed.materialized_context.len(), 1);

    let mut forked = spawn_request_with_id(&fixture, "delegation-forked");
    forked.inheritance = AgentContextMode::ForkedPrefix {
        selection: ForkedAgentContext::LastTurns { count: 1 },
    };
    let forked = fixture.coordinator.spawn(forked).unwrap();
    assert_eq!(forked.context_seed.materialized_context.len(), 1);
    let ModelInvocationPreparation::Ready(invocation) = fixture
        .threads
        .prepare_model_invocation(
            &forked.child_thread_id,
            PrepareModelInvocationRequest {
                turn_id: &forked.child_turn_id,
                harness_context: &HarnessContext::default(),
                extension_fragments: Vec::new(),
                evidence: Vec::new(),
                tools: vec![tool_definition("allowed")],
                budget: ContextBudget::provider_managed(),
            },
        )
        .unwrap()
    else {
        panic!("forked context should be ready")
    };
    assert!(
        invocation
            .context()
            .instructions()
            .iter()
            .any(|instruction| {
                instruction.body().contains("Delegate a review")
                    && instruction.body().contains("inherited-agent-context")
            })
    );
}

#[test]
fn joins_freeze_targets_and_satisfy_all_any_and_quorum_durably() {
    let fixture = fixture();
    let first = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-first"))
        .unwrap();
    let second = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-second"))
        .unwrap();
    for spawned in [&first, &second] {
        fixture
            .threads
            .complete_turn(
                &spawned.child_thread_id,
                &spawned.child_turn_id,
                "done".into(),
            )
            .unwrap();
    }
    fixture
        .coordinator
        .complete_delegation(CompleteDelegationRequest {
            parent_thread_id: fixture.parent_thread_id.clone(),
            delegation_id: first.delegation_id.clone(),
            status: DelegationResultStatus::Completed,
            summary: "first".into(),
            artifacts: Vec::new(),
        })
        .unwrap();

    let any = fixture
        .coordinator
        .join(JoinAgentsRequest {
            join_id: AgentJoinId::new("join-any").unwrap(),
            parent_thread_id: fixture.parent_thread_id.clone(),
            policy: AgentJoinPolicy::Any,
            delegations: None,
        })
        .unwrap();
    assert_eq!(any.join.status, AgentJoinStatus::Satisfied);
    assert_eq!(any.results.len(), 1);
    let all = fixture
        .coordinator
        .join(JoinAgentsRequest {
            join_id: AgentJoinId::new("join-all").unwrap(),
            parent_thread_id: fixture.parent_thread_id.clone(),
            policy: AgentJoinPolicy::All,
            delegations: None,
        })
        .unwrap();
    assert_eq!(all.join.status, AgentJoinStatus::Waiting);
    let quorum = fixture
        .coordinator
        .join(JoinAgentsRequest {
            join_id: AgentJoinId::new("join-quorum").unwrap(),
            parent_thread_id: fixture.parent_thread_id.clone(),
            policy: AgentJoinPolicy::Quorum { count: 2 },
            delegations: None,
        })
        .unwrap();
    assert_eq!(quorum.join.status, AgentJoinStatus::Waiting);

    fixture
        .coordinator
        .complete_delegation(CompleteDelegationRequest {
            parent_thread_id: fixture.parent_thread_id.clone(),
            delegation_id: second.delegation_id,
            status: DelegationResultStatus::Completed,
            summary: "second".into(),
            artifacts: Vec::new(),
        })
        .unwrap();
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    assert_eq!(
        parent
            .agent_joins
            .get(&AgentJoinId::new("join-all").unwrap())
            .unwrap()
            .status,
        AgentJoinStatus::Satisfied
    );
    assert_eq!(
        parent
            .agent_joins
            .get(&AgentJoinId::new("join-quorum").unwrap())
            .unwrap()
            .status,
        AgentJoinStatus::Satisfied
    );

    let first_child = fixture.threads.read_thread(&first.child_thread_id).unwrap();
    let second_child = fixture
        .threads
        .read_thread(&second.child_thread_id)
        .unwrap();
    let tree = project_agent_tree(&[parent, first_child, second_child]);
    assert_eq!(tree.roots[0].joins.len(), 3);
    assert!(
        tree.roots[0]
            .joins
            .iter()
            .all(|join| join.status == AgentJoinStatus::Satisfied)
    );
    assert!(tree.roots[0].children.iter().all(|child| {
        child
            .result
            .as_ref()
            .is_some_and(|result| result.status == DelegationResultStatus::Completed)
    }));
}

#[test]
fn failed_child_is_reconciled_to_one_terminal_result() {
    let fixture = fixture();
    let spawned = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();
    fixture
        .threads
        .fail_turn(
            &spawned.child_thread_id,
            &spawned.child_turn_id,
            ash_protocol::StableTurnError::model_invocation_failed(),
        )
        .unwrap();

    let first = fixture
        .coordinator
        .reconcile_terminal_delegation(&spawned.child_thread_id)
        .unwrap()
        .unwrap();
    let replayed = fixture
        .coordinator
        .reconcile_terminal_delegation(&spawned.child_thread_id)
        .unwrap()
        .unwrap();

    assert_eq!(first, replayed);
    assert_eq!(first.status, DelegationResultStatus::Failed);
    assert_eq!(first.summary, "Model invocation failed");
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    assert_eq!(parent.received_delegation_results.len(), 1);
}

#[test]
fn structural_agent_budget_rejects_a_second_live_child_without_partial_delegation() {
    let fixture = fixture();
    let coordinator = MultiAgentCoordinator::new(
        Arc::clone(&fixture.threads),
        AgentTreeLimits::new(4, 1, 16).unwrap(),
    );
    coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-first"))
        .unwrap();

    let Err(error) = coordinator.spawn(spawn_request_with_id(&fixture, "delegation-over-budget"))
    else {
        panic!("structural Agent budget must reject the second live child")
    };

    assert!(matches!(
        error,
        crate::CoreError::InvalidInput(message)
            if message.contains("maximum live-child count")
    ));
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    assert!(
        !parent
            .delegations
            .contains_key(&DelegationId::new("delegation-over-budget").unwrap())
    );
}

#[test]
fn later_child_turns_cannot_expand_the_spawned_skill_ceiling() {
    let fixture = fixture();
    let spawned = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();
    fixture
        .threads
        .complete_turn(
            &spawned.child_thread_id,
            &spawned.child_turn_id,
            "first turn complete".into(),
        )
        .unwrap();
    let disallowed = FrozenSkillActivation {
        id: SkillId::new(
            SkillSourceId::new("builtin:skill-source:other").unwrap(),
            SkillName::new("other").unwrap(),
        ),
        content_digest: ContentDigest::sha256(b"other body"),
        catalog_generation: 9,
        reason: SkillActivationReason::Automatic,
    };
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.skill_activation_contributor(Arc::new(FixedSkillActivation(disallowed.clone())));
    fixture
        .threads
        .install_extensions(Arc::new(extensions.build()))
        .unwrap();

    let second = fixture
        .threads
        .start_turn(
            &spawned.child_thread_id,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("child-second-turn").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision: "policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "Continue without expanding capabilities".into(),
                }],
            },
        )
        .unwrap();
    let child = fixture
        .threads
        .read_thread(&spawned.child_thread_id)
        .unwrap();
    assert!(child.turns[1].activated_skills.is_empty());
    fixture
        .threads
        .complete_turn(
            &spawned.child_thread_id,
            &second.turn_id,
            "second turn complete".into(),
        )
        .unwrap();

    let mut explicit = disallowed;
    explicit.reason = SkillActivationReason::Explicit;
    let explicit_ref = SkillRef::pinned(explicit.id.clone(), explicit.content_digest.clone());
    let mut extensions = ash_extension_api::ExtensionRegistryBuilder::new();
    extensions.skill_activation_contributor(Arc::new(FixedSkillActivation(explicit)));
    fixture
        .threads
        .install_extensions(Arc::new(extensions.build()))
        .unwrap();
    let result = fixture.threads.start_turn(
        &spawned.child_thread_id,
        StartTurnRequest {
            advisor: None,
            kind: ash_protocol::TurnKind::Coding,
            instructions: crate::test_turn_instructions(),
            command_id: CommandId::new("child-third-turn").unwrap(),
            expected_sequence: SequenceExpectation::Any,
            model: None,
            policy_revision: "policy-v1".into(),
            approval_mode: ash_protocol::ApprovalMode::AskPermissions,
            tool_mode: ash_protocol::ToolMode::Direct,
            tool_profile: None,
            activated_skills: Vec::new(),
            input: vec![UserInput::Skill {
                skill: explicit_ref,
            }],
        },
    );
    assert!(matches!(
        result,
        Err(crate::CoreError::InvalidInput(message))
            if message.contains("outside its frozen capability ceiling")
    ));
}

#[test]
fn cancelling_a_parent_delegation_interrupts_every_live_descendant() {
    let fixture = fixture();
    let child = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-child"))
        .unwrap();
    let grandchild = fixture
        .coordinator
        .spawn(SpawnAgentRequest {
            base_instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
            delegation_id: DelegationId::new("delegation-grandchild").unwrap(),
            session_id: fixture.session_id.clone(),
            parent_thread_id: child.child_thread_id.clone(),
            parent_turn_id: child.child_turn_id.clone(),
            task: DelegatedTask {
                title: "nested".into(),
                instructions: "Check one nested detail".into(),
            },
            role: Some(AgentRoleSnapshot {
                name: "nested".into(),
                instructions: "Return the nested detail.".into(),
                model: None,
                definition: None,
            }),
            inheritance: AgentContextMode::Fresh,
            policy_ceiling: DelegatedPolicyCeiling {
                policy_revision: "policy-v1".into(),
            },
            capability_scope: AgentCapabilityScope {
                tools: Vec::new(),
                delegation_tools: Vec::new(),
                skills: Vec::new(),
            },
        })
        .unwrap();

    let result = fixture
        .coordinator
        .cancel_delegation(&fixture.parent_thread_id, &child.delegation_id)
        .unwrap();
    assert_eq!(result.status, DelegationResultStatus::Cancelled);
    let child_snapshot = fixture.threads.read_thread(&child.child_thread_id).unwrap();
    assert!(
        child_snapshot
            .agent_cancellations_received
            .contains(&child.delegation_id)
    );
    assert_eq!(
        child_snapshot.turns[0].status,
        ash_protocol::TurnStatus::Interrupted
    );
    assert_eq!(
        child_snapshot
            .received_delegation_results
            .get(&grandchild.delegation_id)
            .unwrap()
            .status,
        DelegationResultStatus::Cancelled
    );
    let grandchild_snapshot = fixture
        .threads
        .read_thread(&grandchild.child_thread_id)
        .unwrap();
    assert_eq!(
        grandchild_snapshot.turns[0].status,
        ash_protocol::TurnStatus::Interrupted
    );
}

#[test]
fn recovery_finishes_waiting_joins_and_committed_tree_cancellation() {
    let fixture = fixture();
    let completed = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-completed"))
        .unwrap();
    fixture
        .threads
        .complete_turn(
            &completed.child_thread_id,
            &completed.child_turn_id,
            "done".into(),
        )
        .unwrap();
    fixture
        .coordinator
        .complete_delegation(CompleteDelegationRequest {
            parent_thread_id: fixture.parent_thread_id.clone(),
            delegation_id: completed.delegation_id.clone(),
            status: DelegationResultStatus::Completed,
            summary: "done".into(),
            artifacts: Vec::new(),
        })
        .unwrap();
    let join_id = AgentJoinId::new("join-recovery").unwrap();
    fixture
        .threads
        .record_agent_join_requested(
            &fixture.parent_thread_id,
            AgentJoin {
                join_id: join_id.clone(),
                parent_thread_id: fixture.parent_thread_id.clone(),
                policy: AgentJoinPolicy::All,
                delegations: vec![completed.delegation_id],
                status: AgentJoinStatus::Waiting,
                satisfied_by: Vec::new(),
            },
        )
        .unwrap();
    let cancelled = fixture
        .coordinator
        .spawn(spawn_request_with_id(
            &fixture,
            "delegation-cancel-recovery",
        ))
        .unwrap();
    fixture
        .threads
        .record_delegation_cancellation_requested(
            &fixture.parent_thread_id,
            cancelled.delegation_id.clone(),
        )
        .unwrap();

    fixture
        .coordinator
        .recover_session(&fixture.session_id)
        .unwrap();

    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    assert_eq!(
        parent.agent_joins.get(&join_id).unwrap().status,
        AgentJoinStatus::Satisfied
    );
    assert_eq!(
        parent
            .received_delegation_results
            .get(&cancelled.delegation_id)
            .unwrap()
            .status,
        DelegationResultStatus::Cancelled
    );
}

#[test]
fn recovery_finishes_a_spawn_after_only_the_parent_request_committed() {
    let fixture = fixture();
    let request = spawn_request(&fixture);
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let seed = build_context_seed(request, parent.sequence).unwrap();
    fixture
        .threads
        .record_delegation_requested(&fixture.parent_thread_id, seed)
        .unwrap();

    let recovered = fixture
        .coordinator
        .recover_session(&fixture.session_id)
        .unwrap();

    assert_eq!(recovered.len(), 1);
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let delegation = parent
        .delegations
        .get(&DelegationId::new("delegation-review").unwrap())
        .unwrap();
    assert_eq!(
        delegation.child_thread_id,
        Some(recovered[0].child_thread_id.clone())
    );
}

#[test]
fn messages_and_results_apply_exactly_once_across_threads() {
    let fixture = fixture();
    let spawned = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();
    let delivered = fixture
        .coordinator
        .send_message(message_request(&fixture, &spawned.child_thread_id))
        .unwrap();
    let replayed = fixture
        .coordinator
        .send_message(message_request(&fixture, &spawned.child_thread_id))
        .unwrap();
    assert_eq!(delivered.message, replayed.message);

    let child = fixture
        .threads
        .read_thread(&spawned.child_thread_id)
        .unwrap();
    assert_eq!(child.received_agent_messages.len(), 1);
    let ModelInvocationPreparation::Ready(invocation) = fixture
        .threads
        .prepare_model_invocation(
            &spawned.child_thread_id,
            PrepareModelInvocationRequest {
                turn_id: &spawned.child_turn_id,
                harness_context: &HarnessContext::default(),
                extension_fragments: Vec::new(),
                evidence: Vec::new(),
                tools: vec![tool_definition("allowed")],
                budget: ContextBudget::provider_managed(),
            },
        )
        .unwrap()
    else {
        panic!("provider-managed context should be ready")
    };
    assert!(
        invocation
            .context()
            .instructions()
            .iter()
            .any(|instruction| {
                instruction
                    .body()
                    .contains("Also inspect cancellation handling")
            })
    );

    fixture
        .threads
        .complete_turn(
            &spawned.child_thread_id,
            &spawned.child_turn_id,
            "No regressions found".into(),
        )
        .unwrap();
    let first = fixture
        .coordinator
        .complete_delegation(CompleteDelegationRequest {
            parent_thread_id: fixture.parent_thread_id.clone(),
            delegation_id: spawned.delegation_id.clone(),
            status: DelegationResultStatus::Completed,
            summary: "No regressions found".into(),
            artifacts: Vec::new(),
        })
        .unwrap();
    let replayed = fixture
        .coordinator
        .complete_delegation(CompleteDelegationRequest {
            parent_thread_id: fixture.parent_thread_id.clone(),
            delegation_id: spawned.delegation_id,
            status: DelegationResultStatus::Completed,
            summary: "No regressions found".into(),
            artifacts: Vec::new(),
        })
        .unwrap();
    assert_eq!(first, replayed);

    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    assert_eq!(parent.received_delegation_results.len(), 1);
    assert_eq!(parent.received_agent_messages.len(), 1);
}

#[test]
fn messages_cannot_cross_their_exact_delegation_route() {
    let fixture = fixture();
    let first = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-first"))
        .unwrap();
    let second = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "delegation-second"))
        .unwrap();

    let result = fixture.coordinator.send_message(SendAgentMessageRequest {
        message_id: AgentMessageId::new("wrong-delegation-route").unwrap(),
        delegation_id: Some(first.delegation_id),
        sender_thread_id: fixture.parent_thread_id.clone(),
        receiver_thread_id: second.child_thread_id.clone(),
        text: "This must not reach the sibling delegation".into(),
        provenance: AgentMessageProvenance::Agent,
    });
    let Err(error) = result else {
        panic!("cross-delegation message must be rejected")
    };

    assert!(matches!(
        error,
        crate::CoreError::InvalidInput(message)
            if message.contains("does not bind the sender and receiver Threads")
    ));
    let second_child = fixture
        .threads
        .read_thread(&second.child_thread_id)
        .unwrap();
    assert!(second_child.received_agent_messages.is_empty());
}

#[test]
fn recovery_reconciles_a_terminal_child_result_once_without_a_join() {
    let fixture = fixture();
    let spawned = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();
    fixture
        .threads
        .complete_turn(
            &spawned.child_thread_id,
            &spawned.child_turn_id,
            "Recovered result".into(),
        )
        .unwrap();

    fixture
        .coordinator
        .recover_session(&fixture.session_id)
        .unwrap();
    fixture
        .coordinator
        .recover_session(&fixture.session_id)
        .unwrap();

    let child = fixture
        .threads
        .read_thread(&spawned.child_thread_id)
        .unwrap();
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    assert_eq!(child.produced_delegation_results.len(), 1);
    assert_eq!(parent.received_delegation_results.len(), 1);
    assert_eq!(
        parent
            .received_delegation_results
            .get(&spawned.delegation_id)
            .unwrap()
            .summary,
        "Recovered result"
    );
}

#[test]
fn reducers_reject_corrupted_seed_and_result_digests() {
    let fixture = fixture();
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let mut seed = build_context_seed(spawn_request(&fixture), parent.sequence).unwrap();
    seed.digest =
        ash_protocol::ContextSeedDigest::new(format!("sha256:{}", "0".repeat(64))).unwrap();
    assert!(
        fixture
            .threads
            .record_delegation_requested(&fixture.parent_thread_id, seed)
            .is_err()
    );

    let spawned = fixture.coordinator.spawn(spawn_request(&fixture)).unwrap();
    fixture
        .threads
        .complete_turn(
            &spawned.child_thread_id,
            &spawned.child_turn_id,
            "done".into(),
        )
        .unwrap();
    let child = fixture
        .threads
        .read_thread(&spawned.child_thread_id)
        .unwrap();
    let corrupted = DelegationResult {
        delegation_id: spawned.delegation_id,
        child_thread_id: spawned.child_thread_id.clone(),
        status: DelegationResultStatus::Completed,
        summary: "done".into(),
        artifacts: Vec::new(),
        source_range: ThreadSequenceRange {
            start_sequence: 1,
            end_sequence: child.sequence,
        },
        digest: DelegationResultDigest::new(format!("sha256:{}", "0".repeat(64))).unwrap(),
    };
    assert!(
        fixture
            .threads
            .record_delegation_result_produced(&spawned.child_thread_id, corrupted)
            .is_err()
    );
}

fn fixture() -> Fixture {
    fixture_with_tool_mode(ash_protocol::ToolMode::Direct)
}

fn fixture_with_tool_mode(tool_mode: ash_protocol::ToolMode) -> Fixture {
    fixture_with_agent(tool_mode, None)
}

fn fixture_with_agent(
    tool_mode: ash_protocol::ToolMode,
    agent: Option<ash_protocol::AgentConfiguration>,
) -> Fixture {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let parent = threads
        .start_thread(
            &crate::NoThreadWorktreeBinder,
            StartThreadRequest {
                agent_id: None,
                agent,
                command_id: CommandId::new("create-parent").unwrap(),
                title: "parent".into(),
            },
        )
        .unwrap();
    let turn = threads
        .start_turn(
            &parent.thread_id,
            StartTurnRequest {
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-parent").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                policy_revision: "policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "Delegate a review".into(),
                }],
            },
        )
        .unwrap();
    Fixture {
        coordinator: MultiAgentCoordinator::new(Arc::clone(&threads), AgentTreeLimits::default()),
        threads,
        session_id: parent.session_id,
        parent_thread_id: parent.thread_id,
        parent_turn_id: turn.turn_id,
    }
}

fn spawn_request(fixture: &Fixture) -> SpawnAgentRequest {
    spawn_request_with_id(fixture, "delegation-review")
}

fn spawn_request_with_id(fixture: &Fixture, delegation_id: &str) -> SpawnAgentRequest {
    SpawnAgentRequest {
        base_instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
        delegation_id: DelegationId::new(delegation_id).unwrap(),
        session_id: fixture.session_id.clone(),
        parent_thread_id: fixture.parent_thread_id.clone(),
        parent_turn_id: fixture.parent_turn_id.clone(),
        task: DelegatedTask {
            title: "reviewer".into(),
            instructions: "Review the change".into(),
        },
        role: Some(AgentRoleSnapshot {
            name: "reviewer".into(),
            instructions: "Review code and report concrete findings.".into(),
            model: None,
            definition: None,
        }),
        inheritance: AgentContextMode::Fresh,
        policy_ceiling: DelegatedPolicyCeiling {
            policy_revision: "policy-v1".into(),
        },
        capability_scope: AgentCapabilityScope {
            tools: vec![ToolName::new("allowed").unwrap()],
            delegation_tools: vec![ToolName::new("delegated").unwrap()],
            skills: vec![test_activation()],
        },
    }
}

fn tool_definition(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).unwrap(),
        description: name.into(),
        parameters: serde_json::json!({"type": "object"}),
        strict: true,
    }
}

fn test_activation() -> FrozenSkillActivation {
    FrozenSkillActivation {
        id: SkillId::new(
            SkillSourceId::new("user:skill-source:test").unwrap(),
            SkillName::new("review").unwrap(),
        ),
        content_digest: ContentDigest::sha256(b"review body"),
        catalog_generation: 7,
        reason: SkillActivationReason::Automatic,
    }
}

fn message_request(fixture: &Fixture, child_thread_id: &ThreadId) -> SendAgentMessageRequest {
    SendAgentMessageRequest {
        message_id: AgentMessageId::new("steer-review").unwrap(),
        delegation_id: Some(DelegationId::new("delegation-review").unwrap()),
        sender_thread_id: fixture.parent_thread_id.clone(),
        receiver_thread_id: child_thread_id.clone(),
        text: "Also inspect cancellation handling".into(),
        provenance: AgentMessageProvenance::Agent,
    }
}

#[test]
fn root_role_and_default_worker_share_rules_without_inheriting_responsibilities() {
    for tool_mode in [
        ash_protocol::ToolMode::Direct,
        ash_protocol::ToolMode::CodeModeOnly,
    ] {
        let fixture = fixture_with_agent(
            tool_mode,
            Some(ash_protocol::AgentConfiguration {
                role: Some(AgentRoleSnapshot {
                    name: "coordinator".into(),
                    instructions:
                        "PARENT_ROLE_ONLY_MARKER: coordinate work without implementing it.".into(),
                    model: None,
                    definition: None,
                }),
                capability_scope: AgentCapabilityScope {
                    tools: vec![ToolName::new("allowed").unwrap()],
                    delegation_tools: vec![
                        ToolName::new("allowed").unwrap(),
                        ToolName::new("delegated").unwrap(),
                    ],
                    skills: vec![test_activation()],
                },
                base_instructions: Some(ash_prompts::AGENT_INSTRUCTIONS.freeze()),
            }),
        );
        let mut forbidden = spawn_request_with_id(&fixture, "too-broad");
        forbidden
            .capability_scope
            .tools
            .push(ToolName::new("blocked").unwrap());
        assert!(fixture.coordinator.spawn(forbidden).is_err());
        assert!(
            fixture
                .threads
                .read_thread(&fixture.parent_thread_id)
                .unwrap()
                .delegations
                .is_empty()
        );
        let mut request = spawn_request(&fixture);
        request.role = None;
        request.inheritance = AgentContextMode::ForkedPrefix {
            selection: ForkedAgentContext::Full,
        };
        let spawned = fixture.coordinator.spawn(request).unwrap();
        let child = fixture
            .threads
            .read_thread(&spawned.child_thread_id)
            .unwrap();
        assert!(child.agent_configuration().unwrap().role.is_none());
        for (thread_id, turn_id, expects_parent_role) in [
            (&fixture.parent_thread_id, &fixture.parent_turn_id, true),
            (&spawned.child_thread_id, &spawned.child_turn_id, false),
        ] {
            let ModelInvocationPreparation::Ready(invocation) = fixture
                .threads
                .prepare_model_invocation(
                    thread_id,
                    PrepareModelInvocationRequest {
                        turn_id,
                        harness_context: &HarnessContext::default(),
                        extension_fragments: Vec::new(),
                        evidence: Vec::new(),
                        tools: ["allowed", "blocked", "exec", "wait"]
                            .into_iter()
                            .map(tool_definition)
                            .collect(),
                        budget: ContextBudget::provider_managed(),
                    },
                )
                .unwrap()
            else {
                panic!("fixture context should fit")
            };
            let body = invocation
                .context()
                .instructions()
                .iter()
                .map(|fragment| fragment.body())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(body.contains("Shared working rules"));
            assert!(body.contains("## Tool permissions"));
            assert!(body.contains("Approval mode is `askPermissions`"));
            assert_eq!(
                body.contains("PARENT_ROLE_ONLY_MARKER"),
                expects_parent_role
            );
            let tools = invocation
                .context()
                .tools()
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>();
            assert!(!tools.contains(&"blocked"));
            assert_eq!(tools.contains(&"exec"), tool_mode.requires_code_mode());
        }
    }
}

#[test]
fn completed_children_release_live_capacity_and_recorded_delegations_keep_their_configuration() {
    let mut fixture = fixture();
    fixture.coordinator = MultiAgentCoordinator::new(
        fixture.threads.clone(),
        AgentTreeLimits::new(4, 1, 4).unwrap(),
    );
    let first = fixture
        .coordinator
        .spawn(spawn_request_with_id(&fixture, "first-completed"))
        .unwrap();
    fixture
        .threads
        .complete_turn(&first.child_thread_id, &first.child_turn_id, "done".into())
        .unwrap();
    let before = fixture.threads.read_thread(&first.child_thread_id).unwrap();
    let resumed = fixture
        .coordinator
        .resume_delegation(&fixture.parent_thread_id, &first.delegation_id)
        .unwrap();
    assert_eq!(resumed.context_seed, first.context_seed);
    assert_eq!(
        fixture.threads.read_thread(&first.child_thread_id).unwrap(),
        before
    );
    assert!(
        fixture
            .coordinator
            .spawn(spawn_request_with_id(&fixture, "second-live"))
            .is_ok()
    );
}

#[test]
fn concurrent_spawns_reserve_capacity_once_per_session() {
    let fixture = fixture();
    let barrier = std::sync::Barrier::new(8);
    let succeeded = std::thread::scope(|scope| {
        let handles = (0..8)
            .map(|index| {
                let fixture = &fixture;
                let barrier = &barrier;
                scope.spawn(move || {
                    let coordinator = MultiAgentCoordinator::new(
                        fixture.threads.clone(),
                        AgentTreeLimits::new(4, 2, 8).unwrap(),
                    );
                    barrier.wait();
                    coordinator
                        .spawn(spawn_request_with_id(fixture, &format!("parallel-{index}")))
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| usize::from(handle.join().unwrap()))
            .sum::<usize>()
    });
    assert_eq!(succeeded, 2);
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.parent_thread_id)
            .unwrap()
            .delegations
            .len(),
        2
    );
}

#[test]
fn full_context_uses_original_history_and_appends_delegation_after_the_prefix() {
    let fixture = fixture();
    let parent = fixture
        .threads
        .read_thread(&fixture.parent_thread_id)
        .unwrap();
    let mut request = spawn_request(&fixture);
    request.inheritance = AgentContextMode::ForkedPrefix {
        selection: ForkedAgentContext::Full,
    };
    let spawned = fixture.coordinator.spawn(request).unwrap();
    assert!(spawned.context_seed.materialized_context.is_empty());
    let child = fixture
        .threads
        .read_thread(&spawned.child_thread_id)
        .unwrap();
    assert_eq!(&child.items[..parent.items.len()], parent.items.as_slice());
    let prefix = child.history_sources.get(&parent.thread_id).unwrap();
    assert_eq!(prefix.source_sequence, parent.sequence);
    let ModelInvocationPreparation::Ready(invocation) = fixture
        .threads
        .prepare_model_invocation(
            &child.thread_id,
            PrepareModelInvocationRequest {
                turn_id: &spawned.child_turn_id,
                harness_context: &HarnessContext::default(),
                extension_fragments: vec![],
                evidence: vec![],
                tools: vec![tool_definition("allowed")],
                budget: ContextBudget::provider_managed(),
            },
        )
        .unwrap()
    else {
        panic!("context must fit");
    };
    let request = crate::context::ContextAssembler::assemble(invocation.context()).unwrap();
    let boundary = request.prompt_cache_prefix_end.unwrap() as usize;
    let prefix = serde_json::to_string(&request.input[..=boundary]).unwrap();
    let suffix = serde_json::to_string(&request.input[boundary + 1..]).unwrap();
    assert!(prefix.contains("Delegate a review"));
    assert!(!prefix.contains("This is delegated work"));
    assert!(suffix.contains("This is delegated work"));
}
