use super::*;
use crate::CreateThreadRequest;
use crate::InMemoryThreadStore;
use crate::ProcessExecutionOutput;
use crate::ProcessExitStatus;
use crate::ResolveTurnInteractionRequest;
use crate::SandboxDenialOutput;
use crate::SequenceExpectation;
use crate::StartTurnRequest;
use crate::ToolAuthorization;
use crate::ToolExecutionOutput;
use ash_action_policy::ActionClassifier;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyEngine;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewPhase;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::AssessmentId;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ClassifierAssessment;
use ash_action_policy::ClassifierRecommendation;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::ReviewEvidence;
use ash_action_policy::ReviewEvidenceKind;
use ash_action_policy::ReviewEvidenceTrust;
use ash_action_policy::ReviewFailurePolicy;
use ash_action_policy::RiskLevel;
use ash_action_policy::SandboxCompatibility;
use ash_action_policy::UserAuthorization;
use ash_async_utils::CancellationSource;
use ash_execpolicy::ExecPolicyDefault;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyLayer;
use ash_execpolicy::ExecPolicyLayerId;
use ash_execpolicy::ExecPolicyLayerKind;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_execpolicy::ExecPolicySelector;
use ash_execpolicy::ExecPolicySnapshot;
use ash_protocol::ActionApprovalDecision;
use ash_protocol::ActionApprovalResponse;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::CommandId;
use ash_protocol::DynamicToolOutput;
use ash_protocol::DynamicToolResponse;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionAuthority;
use ash_protocol::ToolName;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

struct DenyBeforeToolHooks;

impl HookService for DenyBeforeToolHooks {
    fn before_tool(
        &self,
        _: &BeforeToolHookRequest,
        _: &CancellationToken,
    ) -> Result<BeforeToolHookDecision, CoreError> {
        Ok(BeforeToolHookDecision::Deny {
            reason: "blocked by native Ash Hook".into(),
        })
    }

    fn after_tool(&self, _: &AfterToolHookRequest, _: &CancellationToken) -> Result<(), CoreError> {
        Ok(())
    }

    fn turn_completed(
        &self,
        _: &crate::TurnCompletedHookRequest,
        _: &CancellationToken,
    ) -> Result<(), CoreError> {
        Ok(())
    }
}

#[test]
fn before_tool_hook_denial_becomes_model_visible_tool_feedback() {
    let policy = Arc::new(ExecAllowPolicy::new());
    let mut fixture = fixture_with(Arc::new(ReviewTool::default()), policy.clone());
    fixture.scheduler = ToolScheduler::new(fixture.threads.clone(), fixture.tools.clone(), policy)
        .with_hooks(Arc::new(DenyBeforeToolHooks));

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: true,
                    ..
                } if tool_call_id == &fixture.call_id && text == "blocked by native Ash Hook"
            ))
    );
}

#[test]
fn tool_preparation_policy_rejection_becomes_model_visible_tool_feedback() {
    let tools = Arc::new(ReviewTool {
        preparation_error: Some(CoreError::Policy(
            "requested path is outside the authorized directories".into(),
        )),
        ..ReviewTool::default()
    });
    let fixture = fixture_with(tools, Arc::new(ExecAllowPolicy::new()));

    assert_eq!(
        fixture
            .scheduler
            .run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
            .unwrap(),
        ToolSchedulingProgress::Complete
    );

    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: true,
                    ..
                } if tool_call_id == &fixture.call_id
                    && text.contains("outside the authorized directories")
            ))
    );
}

#[test]
fn approve_once_resumes_the_exact_tool_call() {
    let fixture = fixture();
    assert!(matches!(
        fixture.scheduler.run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token()
        ),
        Ok(ToolSchedulingProgress::WaitingForApproval)
    ));
    resolve(&fixture, ActionApprovalDecision::ApproveOnce);

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    let authorizations = fixture.tools.authorizations.lock().unwrap();
    assert!(matches!(
        authorizations.as_slice(),
        [ToolAuthorization::ApprovedOnce(grant)]
            if grant.tool_call_id() == &fixture.call_id
    ));
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: false,
                    ..
                } if tool_call_id == &fixture.call_id && text == "executed"
            ))
    );
}

#[test]
fn approved_dynamic_tool_waits_for_its_owner_then_commits_the_response() {
    let fixture = fixture_with(
        Arc::new(ReviewTool {
            dynamic_interaction: true,
            ..ReviewTool::default()
        }),
        Arc::new(AskPolicy),
    );
    assert_eq!(
        fixture
            .scheduler
            .run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
            .unwrap(),
        ToolSchedulingProgress::WaitingForApproval
    );
    resolve(&fixture, ActionApprovalDecision::ApproveOnce);
    assert_eq!(
        fixture
            .scheduler
            .run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
            .unwrap(),
        ToolSchedulingProgress::WaitingForCapability
    );

    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let interaction = snapshot
        .turns
        .last()
        .and_then(|turn| turn.pending_interaction.clone())
        .unwrap();
    let AgentRequest::DynamicTool { call } = &interaction.request else {
        panic!("dynamic execution must request its interaction owner")
    };
    assert_eq!(call.call_id, fixture.call_id);
    assert_eq!(call.name.as_str(), "reviewed");
    assert_eq!(call.arguments, json!({"value": 1}));

    fixture
        .threads
        .resolve_turn_interaction(
            &fixture.thread_id,
            ResolveTurnInteractionRequest {
                command_id: CommandId::new("resolve-dynamic").unwrap(),
                expected_sequence: SequenceExpectation::Exact(snapshot.sequence),
                turn_id: fixture.turn_id.clone(),
                request_id: interaction.request_id,
                response: AgentResponse::DynamicTool {
                    response: DynamicToolResponse {
                        call_id: fixture.call_id.clone(),
                        content: vec![DynamicToolOutput::Text {
                            text: "client result".into(),
                        }],
                        success: true,
                    },
                },
            },
        )
        .unwrap();
    assert_eq!(
        fixture
            .scheduler
            .run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
            .unwrap(),
        ToolSchedulingProgress::Complete
    );
    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult { tool_call_id, text, is_error: false, .. }
                    if tool_call_id == &fixture.call_id && text.contains("client result")
            ))
    );
}

#[test]
fn permission_bypass_executes_with_exact_durable_authority_without_an_interaction() {
    let fixture = fixture_with_approval_mode(
        Arc::new(ReviewTool::default()),
        Arc::new(AskPolicy),
        ash_protocol::ApprovalMode::BypassPermissions,
    );

    assert!(matches!(
        fixture.scheduler.run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token()
        ),
        Ok(ToolSchedulingProgress::Complete)
    ));

    let authorizations = fixture.tools.authorizations.lock().unwrap();
    assert!(matches!(
        authorizations.as_slice(),
        [ToolAuthorization::PermissionBypassed(grant)]
            if grant.tool_call_id() == &fixture.call_id
    ));
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert!(snapshot.turns.last().unwrap().pending_interaction.is_none());
    assert_eq!(
        snapshot
            .tool_execution_starts
            .get(&fixture.call_id)
            .unwrap()
            .authority,
        ToolExecutionAuthority::PermissionBypassed
    );
}

#[test]
fn scheduler_invokes_automatic_review_only_for_interactive_auto_review() {
    use ash_protocol::ApprovalMode;
    use std::sync::atomic::Ordering;

    for mode in [
        ApprovalMode::AskPermissions,
        ApprovalMode::AutoReview,
        ApprovalMode::BypassPermissions,
    ] {
        let policy = Arc::new(ReviewingPolicy {
            base: Arc::new(AskPolicy),
            reviews: Default::default(),
        });
        let fixture =
            fixture_with_approval_mode(Arc::new(ReviewTool::default()), policy.clone(), mode);
        let progress = fixture
            .scheduler
            .run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
            .unwrap();
        let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
        assert_eq!(
            policy.reviews.load(Ordering::SeqCst),
            usize::from(mode == ApprovalMode::AutoReview)
        );
        match mode {
            ApprovalMode::AskPermissions => {
                assert_eq!(progress, ToolSchedulingProgress::WaitingForApproval);
                assert!(snapshot.turns.last().unwrap().pending_interaction.is_some());
                assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
            }
            ApprovalMode::AutoReview => {
                assert_eq!(progress, ToolSchedulingProgress::Complete);
                assert!(snapshot.turns.last().unwrap().pending_interaction.is_none());
                assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
                assert!(snapshot.items.iter().any(|item| matches!(
                    item, ThreadItem::ToolResult { is_error: true, text, .. }
                        if text.contains("review denied")
                )));
            }
            ApprovalMode::BypassPermissions => {
                assert_eq!(progress, ToolSchedulingProgress::Complete);
                assert!(matches!(
                    fixture.tools.authorizations.lock().unwrap().as_slice(),
                    [ToolAuthorization::PermissionBypassed(_)]
                ));
            }
        }
    }
}

#[test]
fn scheduler_preserves_deterministic_decisions_without_automatic_review() {
    let policy = Arc::new(ReviewingPolicy {
        base: Arc::new(ExecAllowPolicy::new()),
        reviews: Default::default(),
    });
    let fixture = fixture_with_approval_mode(
        Arc::new(ReviewTool::default()),
        policy.clone(),
        ash_protocol::ApprovalMode::AutoReview,
    );
    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(policy.reviews.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(matches!(
        fixture.tools.authorizations.lock().unwrap().as_slice(),
        [ToolAuthorization::ExecPolicyGranted(_)]
    ));
}

struct ReviewingPolicy {
    base: Arc<dyn ActionPolicyService>,
    reviews: std::sync::atomic::AtomicUsize,
}

impl ActionPolicyService for ReviewingPolicy {
    fn revision(&self) -> String {
        self.base.revision()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        self.base.decide(request, cancellation)
    }

    fn review_approval(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<Option<ExecutionDecision>, CoreError> {
        self.reviews
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Some(ExecutionDecision::Block(
            ash_action_policy::BlockReason::ReviewerDenied {
                assessment_id: AssessmentId::new("test-review"),
                reason: "review denied".into(),
            },
        )))
    }
}

#[test]
fn exec_policy_grant_is_exactly_bound_and_recorded_before_execution() {
    let fixture = fixture_with(
        Arc::new(ReviewTool::default()),
        Arc::new(ExecAllowPolicy::new()),
    );

    assert_eq!(
        fixture
            .scheduler
            .run_pending(
                &fixture.thread_id,
                &fixture.turn_id,
                &CancellationSource::new().token(),
            )
            .unwrap(),
        ToolSchedulingProgress::Complete
    );

    let authorizations = fixture.tools.authorizations.lock().unwrap();
    assert!(matches!(
        authorizations.as_slice(),
        [ToolAuthorization::ExecPolicyGranted(grant)]
            if grant.tool_call_id() == &fixture.call_id
                && grant.policy_grant().source().rule_id().as_str() == "allow-reviewed"
    ));
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .tool_execution_starts
            .get(&fixture.call_id)
            .unwrap()
            .authority,
        ToolExecutionAuthority::ExecPolicyGranted {
            layer_id: "host".into(),
            rule_id: "allow-reviewed".into(),
            exec_policy_revision: ExecAllowPolicy::snapshot().revision().to_string(),
        }
    );
}

#[test]
fn decline_records_a_tool_failure_without_execution() {
    let fixture = fixture();
    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    resolve(&fixture, ActionApprovalDecision::Decline);

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: true,
                    ..
                } if tool_call_id == &fixture.call_id && text.contains("declined")
            ))
    );
}

#[test]
fn reviewer_approval_executes_with_bound_authority_and_user_context() {
    let observed = Arc::new(Mutex::new(None));
    let tools = Arc::new(ReviewTool {
        requires_escalation: true,
        evidence: vec![ReviewEvidence::new(
            ReviewEvidenceKind::DirectoryFile,
            ReviewEvidenceTrust::UntrustedContent,
            "script.py",
            "print('safe')",
        )],
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        ContextApprovingClassifier {
            observed: observed.clone(),
        },
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );

    assert!(matches!(
        fixture.scheduler.run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token()
        ),
        Ok(ToolSchedulingProgress::Complete)
    ));

    let authorizations = fixture.tools.authorizations.lock().unwrap();
    assert!(matches!(
        authorizations.as_slice(),
        [ToolAuthorization::AutoReviewed(grant)]
            if grant.tool_call_id() == &fixture.call_id
                && grant.policy_grant().assessment_id()
                    == &AssessmentId::new("auto-assessment")
    ));
    let context = observed.lock().unwrap();
    let context = context.as_ref().unwrap();
    assert_eq!(context.user_intent(), "run");
    assert_eq!(context.evidence().len(), 1);
    assert_eq!(context.evidence()[0].source(), "script.py");
}

#[test]
fn safe_sandbox_denial_is_reviewed_and_retried_once() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ReviewTool {
        outputs: Mutex::new(VecDeque::from([
            ToolExecutionOutput::SandboxDenied(SandboxDenialOutput::safe_to_retry(
                "network access denied",
                ProcessExecutionOutput::from_captured_streams(
                    ProcessExitStatus::Code(1),
                    "",
                    "connect: operation not permitted",
                ),
            )),
            ToolExecutionOutput::Success("executed outside sandbox".into()),
        ])),
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        DenialApprovingClassifier {
            observed: observed.clone(),
        },
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    let authorizations = fixture.tools.authorizations.lock().unwrap();
    assert!(matches!(
        authorizations.as_slice(),
        [ToolAuthorization::Sandboxed(_), ToolAuthorization::AutoReviewed(grant)]
            if grant.tool_call_id() == &fixture.call_id
    ));
    let phases = observed.lock().unwrap();
    assert!(matches!(
        phases.as_slice(),
        [ActionReviewPhase::SandboxDenial(denial)]
            if denial.reason() == "network access denied"
                && denial.output() == "connect: operation not permitted"
    ));
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert!(snapshot.escalated_tool_calls.contains(&fixture.call_id));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ThreadItem::ToolResult {
            tool_call_id,
            text,
            is_error: false,
            ..
        } if tool_call_id == &fixture.call_id && text == "executed outside sandbox"
    )));
    let recovered = ThreadController::with_store(fixture.store.clone())
        .recover_thread(&fixture.thread_id)
        .unwrap();
    assert!(recovered.escalated_tool_calls.contains(&fixture.call_id));
    assert_eq!(
        recovered
            .tool_execution_starts
            .get(&fixture.call_id)
            .unwrap()
            .action_digest,
        snapshot
            .tool_execution_starts
            .get(&fixture.call_id)
            .unwrap()
            .action_digest
    );
}

#[test]
fn safe_sandbox_denial_waits_for_one_time_approval_and_resumes_after_recovery() {
    let tools = Arc::new(ReviewTool {
        outputs: Mutex::new(VecDeque::from([
            safe_sandbox_denial(),
            ToolExecutionOutput::Success("approved outside sandbox".into()),
        ])),
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        DenialAskingClassifier,
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );

    assert!(matches!(
        fixture.scheduler.run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token()
        ),
        Ok(ToolSchedulingProgress::WaitingForApproval)
    ));
    assert!(matches!(
        fixture.tools.authorizations.lock().unwrap().as_slice(),
        [ToolAuthorization::Sandboxed(_)]
    ));
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let interaction = snapshot
        .turns
        .last()
        .and_then(|turn| turn.pending_interaction.as_ref())
        .unwrap();
    let AgentRequest::Approval { request } = &interaction.request else {
        panic!("sandbox escalation must request approval");
    };
    let denial = request.sandbox_denial.as_ref().unwrap();
    assert_eq!(denial.reason(), "network access denied");
    assert_eq!(denial.replay_safety(), crate::ToolReplaySafety::SafeToRetry);

    resolve(&fixture, ActionApprovalDecision::ApproveOnce);
    let recovered = Arc::new(ThreadController::with_store(fixture.store.clone()));
    recovered.recover_thread(&fixture.thread_id).unwrap();
    ToolScheduler::new(
        recovered.clone(),
        fixture.tools.clone(),
        Arc::new(AskPolicy),
    )
    .run_pending(
        &fixture.thread_id,
        &fixture.turn_id,
        &CancellationSource::new().token(),
    )
    .unwrap();

    let authorizations = fixture.tools.authorizations.lock().unwrap();
    assert!(matches!(
        authorizations.as_slice(),
        [ToolAuthorization::Sandboxed(_), ToolAuthorization::ApprovedOnce(grant)]
            if grant.tool_call_id() == &fixture.call_id
    ));
    let snapshot = recovered.read_thread(&fixture.thread_id).unwrap();
    assert!(snapshot.escalated_tool_calls.contains(&fixture.call_id));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ThreadItem::ToolResult {
            tool_call_id,
            text,
            is_error: false,
            ..
        } if tool_call_id == &fixture.call_id && text == "approved outside sandbox"
    )));
}

#[test]
fn declining_sandbox_escalation_does_not_retry_the_tool() {
    let tools = Arc::new(ReviewTool {
        outputs: Mutex::new(VecDeque::from([safe_sandbox_denial()])),
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        DenialAskingClassifier,
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );

    assert!(matches!(
        fixture.scheduler.run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token()
        ),
        Ok(ToolSchedulingProgress::WaitingForApproval)
    ));
    resolve(&fixture, ActionApprovalDecision::Decline);
    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(
        fixture.tools.authorizations.lock().unwrap().as_slice(),
        [ToolAuthorization::Sandboxed(_)]
    ));
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert!(!snapshot.escalated_tool_calls.contains(&fixture.call_id));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ThreadItem::ToolResult {
            tool_call_id,
            text,
            is_error: true,
            ..
        } if tool_call_id == &fixture.call_id && text.contains("declined")
    )));
}

#[test]
fn interrupted_approved_sandbox_escalation_is_not_retried() {
    let tools = Arc::new(ReviewTool {
        outputs: Mutex::new(VecDeque::from([safe_sandbox_denial()])),
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        DenialAskingClassifier,
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );
    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let interaction = snapshot
        .turns
        .last()
        .and_then(|turn| turn.pending_interaction.clone())
        .unwrap();
    let denial = match &interaction.request {
        AgentRequest::Approval { request } => request.sandbox_denial.clone().unwrap(),
        _ => panic!("sandbox escalation must request approval"),
    };
    resolve(&fixture, ActionApprovalDecision::ApproveOnce);
    let reviewed = review_request(&durable_call(&fixture), false);
    fixture
        .threads
        .record_tool_execution_escalated(
            &fixture.thread_id,
            &fixture.turn_id,
            crate::thread_controller::RecordToolExecutionEscalation {
                tool_call_id: fixture.call_id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                denial,
                authority: ToolExecutionAuthority::ApprovedOnce {
                    request_id: interaction.request_id,
                },
            },
        )
        .unwrap();

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(
        fixture.tools.authorizations.lock().unwrap().as_slice(),
        [ToolAuthorization::Sandboxed(_)]
    ));
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: true,
                    ..
                } if tool_call_id == &fixture.call_id
                    && text.contains("process interruption")
                    && text.contains("not retried")
            ))
    );
}

fn safe_sandbox_denial() -> ToolExecutionOutput {
    ToolExecutionOutput::SandboxDenied(SandboxDenialOutput::safe_to_retry(
        "network access denied",
        ProcessExecutionOutput::from_captured_streams(
            ProcessExitStatus::Code(1),
            "",
            "connect: operation not permitted",
        ),
    ))
}

#[test]
fn sandbox_denial_with_possible_side_effects_is_not_retried() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let tools = Arc::new(ReviewTool {
        outputs: Mutex::new(VecDeque::from([ToolExecutionOutput::SandboxDenied(
            SandboxDenialOutput::may_have_side_effects(
                "write denied after process launch",
                ProcessExecutionOutput::from_captured_streams(
                    ProcessExitStatus::Code(1),
                    "partial output",
                    "",
                ),
            ),
        )])),
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        DenialApprovingClassifier {
            observed: observed.clone(),
        },
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(
        fixture.tools.authorizations.lock().unwrap().as_slice(),
        [ToolAuthorization::Sandboxed(_)]
    ));
    assert!(observed.lock().unwrap().is_empty());
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    assert!(!snapshot.escalated_tool_calls.contains(&fixture.call_id));
    assert!(snapshot.items.iter().any(|item| matches!(
        item,
        ThreadItem::ToolResult {
            tool_call_id,
            text,
            is_error: true,
            ..
        } if tool_call_id == &fixture.call_id
            && text.contains("may have produced side effects")
            && text.contains("partial output")
    )));
}

#[test]
fn reviewer_revision_returns_structured_safer_path_feedback() {
    let tools = Arc::new(ReviewTool {
        requires_escalation: true,
        ..ReviewTool::default()
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-v1"),
        RevisingClassifier,
        ReviewFailurePolicy::Block,
    );
    let fixture = fixture_with(
        tools,
        Arc::new(crate::approval_request::tests::EnginePolicy(engine)),
    );

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    text,
                    is_error: true,
                    ..
                } if text.starts_with("ash_action_policy_feedback:")
                    && text.contains("\"kind\":\"revise_action\"")
                    && text.contains("\"maximum_capabilities\"")
            ))
    );
}

#[test]
fn started_call_without_a_result_is_not_retried() {
    let fixture = fixture();
    let call = durable_call(&fixture);
    let reviewed = review_request(&call, false);
    fixture
        .threads
        .record_tool_execution_started(
            &fixture.thread_id,
            &fixture.turn_id,
            crate::thread_controller::RecordToolExecutionStart {
                tool_call_id: fixture.call_id.clone(),
                action_digest: reviewed.action().digest().as_str().to_owned(),
                policy_revision: reviewed.action_policy_revision().as_str().to_owned(),
                authority: ash_protocol::ToolExecutionAuthority::Sandboxed,
            },
        )
        .unwrap();

    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .items
            .iter()
            .any(|item| matches!(
                item,
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: true,
                    ..
                } if tool_call_id == &fixture.call_id && text.contains("not retried")
            ))
    );
}

fn durable_call(fixture: &Fixture) -> ToolCall {
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ThreadItem::ToolCall {
                tool_call_id,
                name,
                arguments_json,
                ..
            } if tool_call_id == &fixture.call_id => Some(ToolCall {
                id: tool_call_id.clone(),
                name: name.clone(),
                arguments: serde_json::from_str(arguments_json).unwrap(),
            }),
            _ => None,
        })
        .unwrap()
}

#[test]
fn resolved_approval_survives_recovery_as_a_resumable_continuation() {
    let fixture = fixture();
    fixture
        .scheduler
        .run_pending(
            &fixture.thread_id,
            &fixture.turn_id,
            &CancellationSource::new().token(),
        )
        .unwrap();
    resolve(&fixture, ActionApprovalDecision::ApproveOnce);

    let recovered = Arc::new(ThreadController::with_store(fixture.store.clone()));
    let snapshot = recovered.recover_thread(&fixture.thread_id).unwrap();
    assert_eq!(snapshot.turns.last().unwrap().status, TurnStatus::Running);

    ToolScheduler::new(
        recovered.clone(),
        fixture.tools.clone(),
        Arc::new(AskPolicy),
    )
    .run_pending(
        &fixture.thread_id,
        &fixture.turn_id,
        &CancellationSource::new().token(),
    )
    .unwrap();
    assert!(matches!(
        fixture.tools.authorizations.lock().unwrap().as_slice(),
        [ToolAuthorization::ApprovedOnce(_)]
    ));
}

#[test]
fn recovered_tool_continuation_fails_closed_after_policy_revision_changes() {
    let fixture = fixture();
    let recovered = Arc::new(ThreadController::with_store(fixture.store.clone()));
    recovered.recover_thread(&fixture.thread_id).unwrap();

    let result = ToolScheduler::new(
        recovered.clone(),
        fixture.tools.clone(),
        Arc::new(ChangedPolicy),
    )
    .run_pending(
        &fixture.thread_id,
        &fixture.turn_id,
        &CancellationSource::new().token(),
    );
    let error = match result {
        Ok(_) => panic!("recovered continuation must reject a changed policy revision"),
        Err(error) => error,
    };

    assert!(
        matches!(error, CoreError::Policy(message) if message.contains("changed from test-policy-v1 to test-policy-v2"))
    );
    assert!(fixture.tools.authorizations.lock().unwrap().is_empty());
    assert!(
        recovered
            .read_thread(&fixture.thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .pending_interaction
            .is_none()
    );
}

struct Fixture {
    store: Arc<InMemoryThreadStore>,
    threads: Arc<ThreadController>,
    scheduler: ToolScheduler,
    tools: Arc<ReviewTool>,
    thread_id: ThreadId,
    turn_id: TurnId,
    call_id: ToolCallId,
}

fn fixture() -> Fixture {
    fixture_with(Arc::new(ReviewTool::default()), Arc::new(AskPolicy))
}

fn fixture_with(tools: Arc<ReviewTool>, policy: Arc<dyn ActionPolicyService>) -> Fixture {
    fixture_with_approval_mode(tools, policy, ash_protocol::ApprovalMode::AskPermissions)
}

fn fixture_with_approval_mode(
    tools: Arc<ReviewTool>,
    policy: Arc<dyn ActionPolicyService>,
    approval_mode: ash_protocol::ApprovalMode,
) -> Fixture {
    let store = Arc::new(InMemoryThreadStore::default());
    let threads = Arc::new(ThreadController::with_store(store.clone()));
    let policy_revision = policy.revision();
    let thread_id = ThreadId::new("thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("agent-test").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("session").unwrap(),
            thread_id: thread_id.clone(),
            title: "scheduler".into(),
        })
        .unwrap();
    let turn_id = threads
        .start_turn(
            &thread_id,
            StartTurnRequest {
                kind: ash_protocol::TurnKind::Coding,
                instructions: crate::test_turn_instructions(),
                command_id: CommandId::new("start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                policy_revision,
                approval_mode,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text { text: "run".into() }],
            },
        )
        .unwrap()
        .turn_id;
    let call_id = ToolCallId::new("call-1").unwrap();
    let call = ToolCall {
        id: call_id.clone(),
        name: ToolName::new("reviewed").unwrap(),
        arguments: json!({"value": 1}),
    };
    let binding = tools
        .bind_call(&call, ash_protocol::ToolCallCaller::Direct)
        .unwrap()
        .unwrap();
    threads
        .record_model_tool_call(&thread_id, &turn_id, &call, binding)
        .unwrap();
    let scheduler = ToolScheduler::new(threads.clone(), tools.clone(), policy);
    Fixture {
        store,
        threads,
        scheduler,
        tools,
        thread_id,
        turn_id,
        call_id,
    }
}

fn resolve(fixture: &Fixture, decision: ActionApprovalDecision) {
    let snapshot = fixture.threads.read_thread(&fixture.thread_id).unwrap();
    let interaction = snapshot
        .turns
        .iter()
        .find(|turn| turn.turn_id == fixture.turn_id)
        .and_then(|turn| turn.pending_interaction.clone())
        .unwrap();
    fixture
        .threads
        .resolve_turn_interaction(
            &fixture.thread_id,
            ResolveTurnInteractionRequest {
                command_id: CommandId::new(format!("resolve-{decision:?}")).unwrap(),
                expected_sequence: SequenceExpectation::Exact(snapshot.sequence),
                turn_id: fixture.turn_id.clone(),
                request_id: interaction.request_id,
                response: AgentResponse::Approval {
                    response: ActionApprovalResponse { decision },
                },
            },
        )
        .unwrap();
    assert_eq!(
        fixture
            .threads
            .read_thread(&fixture.thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::Running
    );
}

struct ReviewTool {
    authorizations: Mutex<Vec<ToolAuthorization>>,
    outputs: Mutex<VecDeque<ToolExecutionOutput>>,
    requires_escalation: bool,
    evidence: Vec<ReviewEvidence>,
    dynamic_interaction: bool,
    preparation_error: Option<CoreError>,
}

impl Default for ReviewTool {
    fn default() -> Self {
        Self {
            authorizations: Mutex::new(Vec::new()),
            outputs: Mutex::new(VecDeque::new()),
            requires_escalation: false,
            evidence: Vec::new(),
            dynamic_interaction: false,
            preparation_error: None,
        }
    }
}

impl ToolService for ReviewTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("reviewed").unwrap(),
            description: "reviewed test tool".into(),
            parameters: json!({
                "type": "object",
                "properties": {"value": {"type": "integer"}},
                "required": ["value"],
                "additionalProperties": false
            }),
            strict: true,
        }]
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if let Some(error) = &self.preparation_error {
            return Err(error.clone());
        }
        Ok(review_request(call, self.requires_escalation))
    }

    fn execution_interaction(&self, call: &ToolCall) -> Result<Option<AgentRequest>, CoreError> {
        Ok(self.dynamic_interaction.then(|| AgentRequest::DynamicTool {
            call: ash_protocol::DynamicToolCall {
                call_id: call.id.clone(),
                name: call.name.clone(),
                definition_digest: "a".repeat(64),
                arguments: call.arguments.clone(),
            },
        }))
    }

    fn resolve_execution_interaction(
        &self,
        call: &ToolCall,
        request: &AgentRequest,
        response: &AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        if !self.dynamic_interaction {
            return Ok(None);
        }
        let (
            AgentRequest::DynamicTool {
                call: requested_call,
            },
            AgentResponse::DynamicTool { response },
        ) = (request, response)
        else {
            return Ok(None);
        };
        if requested_call.call_id != call.id || response.call_id != call.id {
            return Err(CoreError::Policy(
                "dynamic response does not match Tool Call".into(),
            ));
        }
        let text = serde_json::to_string(&response.content).unwrap();
        Ok(Some(if response.success {
            ToolExecutionOutput::Success(text)
        } else {
            ToolExecutionOutput::Failure(text)
        }))
    }

    fn review_evidence(&self, _: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        Ok(self.evidence.clone())
    }

    fn execute(
        &self,
        _: &ToolCall,
        authorization: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.authorizations
            .lock()
            .unwrap()
            .push(authorization.clone());
        Ok(self
            .outputs
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| ToolExecutionOutput::Success("executed".into())))
    }
}

struct AskPolicy;

struct ExecAllowPolicy {
    snapshot: ExecPolicySnapshot,
}

impl ExecAllowPolicy {
    fn snapshot() -> ExecPolicySnapshot {
        ExecPolicySnapshot::new(
            ExecPolicyDefault::Continue,
            vec![ExecPolicyLayer::new(
                ExecPolicyLayerId::new("host"),
                ExecPolicyLayerKind::Host,
                [ExecPolicyRule::new(
                    ExecPolicyRuleId::new("allow-reviewed"),
                    ExecPolicySelector::source(
                        Some("built_in_tool".into()),
                        Some("reviewed".into()),
                    ),
                    ExecPolicyEffect::AllowUnsandboxed,
                )],
            )],
        )
        .unwrap()
    }

    fn new() -> Self {
        Self {
            snapshot: Self::snapshot(),
        }
    }
}

struct NeverClassify;

impl ActionClassifier for NeverClassify {
    type Error = std::convert::Infallible;

    fn classify(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        panic!("deterministic allow must not call the classifier")
    }
}

impl ActionPolicyService for ExecAllowPolicy {
    fn revision(&self) -> String {
        "policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        ActionPolicyEngine::new(
            ActionPolicyRevision::new(self.revision()),
            self.snapshot.clone(),
            NeverClassify,
            ReviewFailurePolicy::Block,
        )
        .decide(request, cancellation)
        .map_err(|error| CoreError::Policy(error.to_string()))
    }
}

struct ChangedPolicy;

impl ActionPolicyService for ChangedPolicy {
    fn revision(&self) -> String {
        "test-policy-v2".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        panic!("revision mismatch must fail before evaluating the changed policy")
    }
}

impl ActionPolicyService for AskPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::AskUser(ApprovalRequest::new(
            request.action().digest().clone(),
            request.action().required_capabilities().clone(),
            "external mutation requires approval",
        )))
    }
}

struct ContextApprovingClassifier {
    observed: Arc<Mutex<Option<ash_action_policy::ReviewContext>>>,
}

struct DenialApprovingClassifier {
    observed: Arc<Mutex<Vec<ActionReviewPhase>>>,
}

struct DenialAskingClassifier;

#[derive(Debug)]
struct ContextClassifierError;

impl std::fmt::Display for ContextClassifierError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("context classifier failed")
    }
}

impl std::error::Error for ContextClassifierError {}

impl ActionClassifier for ContextApprovingClassifier {
    type Error = ContextClassifierError;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        *self.observed.lock().unwrap() = Some(request.context().clone());
        Ok(ClassifierAssessment::new(
            AssessmentId::new("auto-assessment"),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "test-prompt",
            ClassifierRecommendation::Approve {
                capabilities: request.action().required_capabilities().clone(),
                risk: RiskLevel::Medium,
                user_authorization: UserAuthorization::Implicit,
                reason: "matches the requested operation".into(),
            },
        ))
    }
}

impl ActionClassifier for DenialApprovingClassifier {
    type Error = ContextClassifierError;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        self.observed.lock().unwrap().push(request.phase().clone());
        Ok(ClassifierAssessment::new(
            AssessmentId::new("denial-assessment"),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "test-prompt",
            ClassifierRecommendation::Approve {
                capabilities: request.action().required_capabilities().clone(),
                risk: RiskLevel::Medium,
                user_authorization: UserAuthorization::Implicit,
                reason: "outside-sandbox retry is allowed".into(),
            },
        ))
    }
}

impl ActionClassifier for DenialAskingClassifier {
    type Error = ContextClassifierError;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        assert!(matches!(
            request.phase(),
            ActionReviewPhase::SandboxDenial(_)
        ));
        Ok(ClassifierAssessment::new(
            AssessmentId::new("denial-user-assessment"),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "test-prompt",
            ClassifierRecommendation::Approve {
                capabilities: request.action().required_capabilities().clone(),
                risk: RiskLevel::High,
                user_authorization: UserAuthorization::Implicit,
                reason: "outside-sandbox retry requires explicit user approval".into(),
            },
        ))
    }
}

struct RevisingClassifier;

impl ActionClassifier for RevisingClassifier {
    type Error = ContextClassifierError;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        Ok(ClassifierAssessment::new(
            AssessmentId::new("revise-assessment"),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "test-prompt",
            ClassifierRecommendation::ReviseAction {
                maximum_capabilities: CapabilitySet::default(),
                reason: "use a read-only inspection first".into(),
            },
        ))
    }
}

fn review_request(call: &ToolCall, requires_escalation: bool) -> ActionReviewRequest {
    let capabilities = CapabilitySet::new([Capability::new(
        CapabilityKind::ExternalMutation,
        "reviewed/value/1",
    )]);
    ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(format!("{}:{}", call.name, call.arguments)),
            ActionKind::ExternalServiceMutation,
            "mutate reviewed value",
            capabilities,
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "reviewed"),
        if requires_escalation {
            SandboxCompatibility::NotApplicable {
                reason: "external mutation".into(),
            }
        } else {
            SandboxCompatibility::Supported(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            ))
        },
        ActionPolicyRevision::new("policy-v1"),
    )
}
