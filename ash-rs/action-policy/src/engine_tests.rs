use super::*;
use crate::{
    ActionDigest, ActionKind, ActionProvenance, ActionSource, AssessmentId, Capability,
    CapabilityKind, CapabilitySet, GrantId, ProcessInvocationKind, ResolvedAction,
    SandboxDenialEvidence, UnsandboxedGrant, UserAllowlist,
};
use ash_async_utils::{CancellationSource, CancellationToken};
use ash_execpolicy::ExecPolicyDefault;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyLayer;
use ash_execpolicy::ExecPolicyLayerId;
use ash_execpolicy::ExecPolicyLayerKind;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_execpolicy::ExecPolicySelector;
use ash_execpolicy::ExecPolicySnapshot;
use ash_sandboxing::{FileSystemAccess, NetworkAccess, SandboxPolicy};
use std::fmt;

#[derive(Clone, Debug)]
struct TestClassifierError(&'static str);

impl fmt::Display for TestClassifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for TestClassifierError {}

struct PanicClassifier;

impl ActionClassifier for PanicClassifier {
    type Error = TestClassifierError;

    fn classify(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        panic!("classifier should not have been called")
    }
}

struct StaticClassifier(Result<ClassifierAssessment, TestClassifierError>);

impl ActionClassifier for StaticClassifier {
    type Error = TestClassifierError;

    fn classify(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        self.0.clone()
    }
}

fn capability() -> Capability {
    Capability::new(CapabilityKind::Network, "api.example.com")
}

fn request(sandbox: SandboxCompatibility) -> ActionReviewRequest {
    ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"curl api.example.com"),
            ActionKind::LocalProcess(ProcessInvocationKind::Direct),
            "call the configured API",
            CapabilitySet::new([capability()]),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
        sandbox,
        ActionPolicyRevision::new("policy-1"),
    )
}

fn decide<C: ActionClassifier>(
    engine: &ActionPolicyEngine<C>,
    request: &ActionReviewRequest,
) -> Result<ExecutionDecision, PolicyError> {
    engine.decide(request, &CancellationSource::new().token())
}

fn exact_exec_policy(digest: &ActionDigest, effect: ExecPolicyEffect) -> ExecPolicySnapshot {
    ExecPolicySnapshot::new(
        ExecPolicyDefault::Continue,
        vec![ExecPolicyLayer::new(
            ExecPolicyLayerId::new("host"),
            ExecPolicyLayerKind::Host,
            [ExecPolicyRule::new(
                ExecPolicyRuleId::new("test-rule"),
                ExecPolicySelector::ActionDigest {
                    digest: digest.as_str().to_owned(),
                },
                effect,
            )],
        )],
    )
    .unwrap()
}

#[test]
fn supported_actions_run_in_the_sandbox_without_classifier_review() {
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied);
    let request = request(SandboxCompatibility::Supported(policy));
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        PanicClassifier,
        ReviewFailurePolicy::Block,
    );

    assert_eq!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::RunSandboxed(policy)
    );
}

#[test]
fn review_after_authoritative_ask_user_does_not_reapply_the_sandbox_fast_path() {
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied);
    let request = request(SandboxCompatibility::Supported(policy));
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-after-ask"),
        request.action().digest().clone(),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::Approve {
            capabilities: request.action().required_capabilities().clone(),
            risk: RiskLevel::Medium,
            user_authorization: UserAuthorization::Explicit,
            reason: "the authoritative policy requested contextual review".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        engine
            .review_after_authoritative_ask_user(&request, &CancellationSource::new().token())
            .unwrap(),
        ExecutionDecision::RunAutoReviewed(_)
    ));
}

#[test]
fn confirmed_sandbox_denial_reaches_the_classifier() {
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied);
    let request = request(SandboxCompatibility::Supported(policy)).after_sandbox_denial(
        SandboxDenialEvidence::new("network access denied", "operation not permitted"),
    );
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-after-denial"),
        request.action().digest().clone(),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::Approve {
            capabilities: request.action().required_capabilities().clone(),
            risk: RiskLevel::Medium,
            user_authorization: UserAuthorization::Implicit,
            reason: "the requested API call requires network access".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::RunAutoReviewed(_)
    ));
}

#[test]
fn exact_user_allowlist_entry_remains_an_explicit_unsandboxed_path() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let grant = UnsandboxedGrant::new(
        GrantId::new("grant-1"),
        request.action().digest().clone(),
        request.action().required_capabilities().clone(),
        request.action_policy_revision().clone(),
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        PanicClassifier,
        ReviewFailurePolicy::Block,
    )
    .with_user_allowlist(UserAllowlist::new([grant]));

    assert_eq!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::RunUnsandboxed {
            grant_id: GrantId::new("grant-1")
        }
    );
}

#[test]
fn medium_risk_implicitly_authorized_action_receives_a_bound_auto_review_grant() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-1"),
        request.action().digest().clone(),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::Approve {
            capabilities: request.action().required_capabilities().clone(),
            risk: RiskLevel::Medium,
            user_authorization: UserAuthorization::Implicit,
            reason: "the API call needs network access".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    let ExecutionDecision::RunAutoReviewed(grant) = decide(&engine, &request).unwrap() else {
        panic!("eligible reviewer approval must create a policy-bound grant");
    };
    assert_eq!(grant.assessment_id(), &AssessmentId::new("assessment-1"));
    assert!(grant.matches(
        request.action().digest(),
        request.action().required_capabilities(),
        request.action_policy_revision()
    ));
}

#[test]
fn invalid_approval_capabilities_fail_closed_for_any_classifier() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let invalid_capability_sets = [
        CapabilitySet::default(),
        CapabilitySet::new([Capability::new(CapabilityKind::SystemConfiguration, "host")]),
    ];

    for (index, capabilities) in invalid_capability_sets.into_iter().enumerate() {
        let assessment = ClassifierAssessment::new(
            AssessmentId::new(format!("assessment-invalid-{index}")),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "test-protocol",
            ClassifierRecommendation::Approve {
                capabilities,
                risk: RiskLevel::Medium,
                user_authorization: UserAuthorization::Explicit,
                reason: "invalid approval".to_owned(),
            },
        );
        let engine = ActionPolicyEngine::with_no_exec_rules(
            ActionPolicyRevision::new("policy-1"),
            StaticClassifier(Ok(assessment)),
            ReviewFailurePolicy::Block,
        );

        assert!(matches!(
            decide(&engine, &request).unwrap(),
            ExecutionDecision::Block(BlockReason::ReviewFailed { .. })
        ));
    }
}

#[test]
fn high_risk_action_without_explicit_authorization_asks_the_user() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-2"),
        request.action().digest().clone(),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::Approve {
            capabilities: request.action().required_capabilities().clone(),
            risk: RiskLevel::High,
            user_authorization: UserAuthorization::Implicit,
            reason: "publishes externally".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::AskUser(_)
    ));
}

#[test]
fn critical_risk_action_cannot_be_auto_approved() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-3"),
        request.action().digest().clone(),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::Approve {
            capabilities: request.action().required_capabilities().clone(),
            risk: RiskLevel::Critical,
            user_authorization: UserAuthorization::Explicit,
            reason: "would exfiltrate credentials".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::Block(BlockReason::CriticalRisk { .. })
    ));
}

#[test]
fn revised_action_cannot_broaden_the_resolved_capabilities() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-revision"),
        request.action().digest().clone(),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::ReviseAction {
            maximum_capabilities: CapabilitySet::new([
                capability(),
                Capability::new(CapabilityKind::SystemConfiguration, "host"),
            ]),
            reason: "use a different action".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::Block(BlockReason::ReviewFailed { .. })
    ));
}

#[test]
fn deterministic_deny_never_calls_the_classifier() {
    let request = request(SandboxCompatibility::NotApplicable {
        reason: "external action".to_owned(),
    });
    let exec_policy = exact_exec_policy(
        request.action().digest(),
        ExecPolicyEffect::Deny("blocked by administrator".to_owned()),
    );
    let engine = ActionPolicyEngine::new(
        ActionPolicyRevision::new("policy-1"),
        exec_policy,
        PanicClassifier,
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::Block(BlockReason::DeterministicRule { .. })
    ));
}

#[test]
fn classifier_failure_asks_only_when_the_host_selected_that_failure_policy() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Err(TestClassifierError("offline"))),
        ReviewFailurePolicy::AskUser,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::AskUser(_)
    ));
}

#[test]
fn rejects_assessment_bound_to_another_action() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let assessment = ClassifierAssessment::new(
        AssessmentId::new("assessment-other"),
        ActionDigest::from_canonical_bytes(b"another action"),
        request.action_policy_revision().clone(),
        "test-prompt",
        ClassifierRecommendation::Deny {
            reason: "blocked".to_owned(),
        },
    );
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        StaticClassifier(Ok(assessment)),
        ReviewFailurePolicy::Block,
    );

    assert_eq!(
        decide(&engine, &request),
        Err(PolicyError::ClassifierBindingMismatch)
    );
}

#[test]
fn built_in_sandbox_requirement_overrides_the_user_allowlist() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network unavailable".to_owned(),
    });
    let exec_policy =
        exact_exec_policy(request.action().digest(), ExecPolicyEffect::RequireSandbox);
    let grant = UnsandboxedGrant::new(
        GrantId::new("grant-1"),
        request.action().digest().clone(),
        request.action().required_capabilities().clone(),
        request.action_policy_revision().clone(),
    );
    let engine = ActionPolicyEngine::new(
        ActionPolicyRevision::new("policy-1"),
        exec_policy,
        PanicClassifier,
        ReviewFailurePolicy::Block,
    )
    .with_user_allowlist(UserAllowlist::new([grant]));

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::Block(BlockReason::SandboxRequiredButUnavailable { .. })
    ));
}

#[test]
fn require_sandbox_rule_blocks_after_the_sandbox_denies_execution() {
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied);
    let request = request(SandboxCompatibility::Supported(policy)).after_sandbox_denial(
        SandboxDenialEvidence::new("network access denied", "operation not permitted"),
    );
    let exec_policy =
        exact_exec_policy(request.action().digest(), ExecPolicyEffect::RequireSandbox);
    let engine = ActionPolicyEngine::new(
        ActionPolicyRevision::new("policy-1"),
        exec_policy,
        PanicClassifier,
        ReviewFailurePolicy::Block,
    );

    assert!(matches!(
        decide(&engine, &request).unwrap(),
        ExecutionDecision::Block(BlockReason::SandboxRequiredButUnavailable { .. })
    ));
}

#[test]
fn deterministic_allow_creates_an_exact_action_policy_grant() {
    let request = request(SandboxCompatibility::NotApplicable {
        reason: "host-mediated action".to_owned(),
    });
    let exec_policy = exact_exec_policy(
        request.action().digest(),
        ExecPolicyEffect::AllowUnsandboxed,
    );
    let expected_exec_revision = exec_policy.revision().clone();
    let engine = ActionPolicyEngine::new(
        ActionPolicyRevision::new("policy-1"),
        exec_policy,
        PanicClassifier,
        ReviewFailurePolicy::Block,
    );

    let ExecutionDecision::RunExecPolicyGranted(grant) = decide(&engine, &request).unwrap() else {
        panic!("deterministic allow must create an exact action-policy grant");
    };
    assert_eq!(grant.exec_policy_revision(), &expected_exec_revision);
    assert!(grant.matches(
        request.action().digest(),
        request.action().required_capabilities(),
        request.action_policy_revision(),
    ));
}
