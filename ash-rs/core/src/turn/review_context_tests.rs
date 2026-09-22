use super::*;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_protocol::CommandId;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use ash_protocol::UserInput;
use std::sync::Arc;

fn fixture() -> (Arc<ThreadController>, ThreadSnapshot) {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        crate::InMemoryThreadStore::default(),
    )));
    let root = threads
        .start_thread(
            &crate::NoThreadWorktreeBinder,
            crate::StartThreadRequest {
                agent_id: None,
                agent: None,
                command_id: CommandId::new("root").unwrap(),
                title: "Root".into(),
            },
        )
        .unwrap();
    (threads, root)
}

fn turn(threads: &ThreadController, thread: &ThreadId, text: &str) -> TurnId {
    threads
        .start_turn(
            thread,
            crate::StartTurnRequest {
                advisor: None,
                command_id: CommandId::new(text).unwrap(),
                expected_sequence: crate::SequenceExpectation::Any,
                model: None,
                kind: Default::default(),
                instructions: crate::test_turn_instructions(),
                policy_revision: "policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![UserInput::Text { text: text.into() }],
            },
        )
        .unwrap()
        .turn_id
}

fn review(threads: &ThreadController, snapshot: &ThreadSnapshot) -> ReviewContext {
    attach_review_context(
        request(),
        threads,
        snapshot,
        &ItemId::new("pending").unwrap(),
        vec![],
    )
    .unwrap()
    .context()
    .clone()
}

#[test]
fn review_history_retains_prior_intent_and_latest_restriction_in_order() {
    let (threads, root) = fixture();
    let first = turn(&threads, &root.thread_id, "Prepare deployment");
    threads
        .complete_turn(&root.thread_id, &first, "I can deploy".into())
        .unwrap();
    turn(&threads, &root.thread_id, "Do not publish");
    let snapshot = threads.read_thread(&root.thread_id).unwrap();
    let context = review(&threads, &snapshot);
    assert_eq!(context.user_intent(), "Do not publish");
    assert_eq!(
        context
            .evidence()
            .iter()
            .map(|e| (e.kind(), e.content()))
            .collect::<Vec<_>>(),
        [
            (ReviewEvidenceKind::UserMessage, "Prepare deployment"),
            (ReviewEvidenceKind::AgentMessage, "I can deploy"),
            (ReviewEvidenceKind::UserMessage, "Do not publish"),
        ]
    );
    assert_eq!(
        context.evidence()[1].trust(),
        ReviewEvidenceTrust::UntrustedContent
    );
}

#[test]
fn delegated_review_uses_frozen_parent_authority_and_fork_preserves_sources() {
    let (threads, root) = fixture();
    let parent_turn = turn(&threads, &root.thread_id, "Inspect files only");
    let spawned =
        crate::MultiAgentCoordinator::new(threads.clone(), crate::AgentTreeLimits::default())
            .spawn(crate::SpawnAgentRequest {
                base_instructions: crate::test_turn_instructions(),
                delegation_id: ash_protocol::DelegationId::new("review").unwrap(),
                session_id: root.session_id.clone(),
                parent_thread_id: root.thread_id.clone(),
                parent_turn_id: parent_turn.clone(),
                task: ash_protocol::DelegatedTask {
                    title: "review".into(),
                    instructions: "Publish everything".into(),
                },
                role: None,
                inheritance: ash_protocol::AgentContextMode::ForkedPrefix {
                    selection: ash_protocol::ForkedAgentContext::Full,
                },
                policy_ceiling: ash_protocol::DelegatedPolicyCeiling {
                    policy_revision: "policy-v1".into(),
                },
                capability_scope: ash_protocol::AgentCapabilityScope {
                    tools: vec![],
                    delegation_tools: vec![],
                    skills: vec![],
                },
            })
            .unwrap();
    threads
        .steer_turn(
            &root.thread_id,
            crate::SteerTurnRequest {
                command_id: CommandId::new("later").unwrap(),
                expected_sequence: crate::SequenceExpectation::Any,
                turn_id: parent_turn,
                input: vec![UserInput::Text {
                    text: "Later unrelated permission".into(),
                }],
            },
        )
        .unwrap();
    let child = threads.read_thread(&spawned.child_thread_id).unwrap();
    let context = review(&threads, &child);
    assert_eq!(context.user_intent(), "Inspect files only");
    assert_eq!(context.evidence().len(), 2);
    assert_eq!(context.evidence()[1].kind(), ReviewEvidenceKind::Delegation);
    assert_eq!(
        context.evidence()[1].trust(),
        ReviewEvidenceTrust::UntrustedContent
    );
    assert!(
        context.evidence()[0]
            .source()
            .contains(root.thread_id.as_str())
    );

    let fork = threads
        .create_forked_thread(crate::CreateForkedThreadRequest {
            session_id: root.session_id,
            thread_id: ThreadId::new("fork").unwrap(),
            title: "fork".into(),
            source_thread_id: child.thread_id.clone(),
            source_sequence: child.sequence,
        })
        .unwrap();
    assert_eq!(review(&threads, &fork), context);
    threads
        .steer_turn(
            &child.thread_id,
            crate::SteerTurnRequest {
                command_id: CommandId::new("child-user").unwrap(),
                expected_sequence: crate::SequenceExpectation::Any,
                turn_id: spawned.child_turn_id,
                input: vec![UserInput::Text {
                    text: "Only inspect README".into(),
                }],
            },
        )
        .unwrap();
    let steered = review(&threads, &threads.read_thread(&child.thread_id).unwrap());
    assert_eq!(steered.user_intent(), "Only inspect README");
    assert_eq!(steered.evidence()[1].kind(), ReviewEvidenceKind::Delegation);
    assert_eq!(
        steered.evidence()[2].trust(),
        ReviewEvidenceTrust::TrustedUser
    );
}

#[test]
fn user_answers_keep_their_question_and_precede_a_later_revocation() {
    let (threads, root) = fixture();
    let turn_id = turn(&threads, &root.thread_id, "Prepare deployment");
    let request_id = ash_protocol::RequestId::new("confirm").unwrap();
    threads
        .request_turn_interaction(
            &root.thread_id,
            &turn_id,
            crate::RequestTurnInteraction {
                request_id: request_id.clone(),
                item_id: None,
                deadline: None,
                request: ash_protocol::AgentRequest::UserInput {
                    request: ash_protocol::RequestUserInput {
                        questions: vec![ash_protocol::UserInputQuestion {
                            id: "destination".into(),
                            header: "Destination".into(),
                            question: "Where may I publish?".into(),
                            options: vec![],
                            allow_free_form: true,
                        }],
                    },
                },
            },
        )
        .unwrap();
    threads
        .resolve_turn_interaction(
            &root.thread_id,
            crate::ResolveTurnInteractionRequest {
                command_id: CommandId::new("answer").unwrap(),
                expected_sequence: crate::SequenceExpectation::Any,
                turn_id: turn_id.clone(),
                request_id,
                response: ash_protocol::AgentResponse::UserInput {
                    response: ash_protocol::RequestUserInputResponse {
                        answers: Default::default(),
                    },
                },
            },
        )
        .unwrap();
    threads
        .steer_turn(
            &root.thread_id,
            crate::SteerTurnRequest {
                command_id: CommandId::new("revoke").unwrap(),
                expected_sequence: crate::SequenceExpectation::Any,
                turn_id,
                input: vec![UserInput::Text {
                    text: "Do not publish".into(),
                }],
            },
        )
        .unwrap();
    let context = review(&threads, &threads.read_thread(&root.thread_id).unwrap());
    assert_eq!(context.evidence()[1].kind(), ReviewEvidenceKind::UserAnswer);
    assert!(
        context.evidence()[1]
            .content()
            .contains("Where may I publish?")
    );
    assert_eq!(context.evidence()[2].content(), "Do not publish");
}

#[test]
fn fork_review_reads_its_retained_prefix_after_the_source_session_is_deleted() {
    let (threads, root) = fixture();
    let turn_id = turn(&threads, &root.thread_id, "Read files only");
    threads
        .complete_turn(&root.thread_id, &turn_id, "Understood".into())
        .unwrap();
    let source = threads.read_thread(&root.thread_id).unwrap();
    let fork = threads
        .create_forked_thread(crate::CreateForkedThreadRequest {
            session_id: ash_protocol::SessionId::new("kept").unwrap(),
            thread_id: ThreadId::new("kept").unwrap(),
            title: "kept".into(),
            source_thread_id: root.thread_id.clone(),
            source_sequence: source.sequence,
        })
        .unwrap();
    threads
        .archive_session_threads(
            &root.session_id,
            &CommandId::new("archive").unwrap(),
            ash_protocol::ThreadArchiveReason::Stopped,
        )
        .unwrap();
    threads.delete_session_threads(&root.session_id).unwrap();
    assert_eq!(review(&threads, &fork).user_intent(), "Read files only");
}

fn request() -> ActionReviewRequest {
    ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"deploy"),
            ActionKind::SystemOperation,
            "deploy preview",
            CapabilitySet::default(),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "shell"),
        SandboxCompatibility::NotApplicable {
            reason: "external deployment".into(),
        },
        ActionPolicyRevision::new("policy-1"),
    )
}
