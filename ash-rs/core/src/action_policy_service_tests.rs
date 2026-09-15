use super::*;
use ash_action_policy::ActionClassifier;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyEngine;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionSource;
use ash_action_policy::AssessmentId;
use ash_action_policy::Capability;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ClassifierAssessment;
use ash_action_policy::ClassifierRecommendation;
use ash_action_policy::ProcessInvocationKind;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationSource;
use ash_protocol::ApprovalMode;
use std::fmt;

#[derive(Debug)]
struct ClassifierError;

impl fmt::Display for ClassifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("classifier failed")
    }
}

impl std::error::Error for ClassifierError {}

struct AskClassifier;

impl ActionClassifier for AskClassifier {
    type Error = ClassifierError;

    fn classify(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ClassifierAssessment, Self::Error> {
        Ok(ClassifierAssessment::new(
            AssessmentId::new("ask-assessment"),
            request.action().digest().clone(),
            request.action_policy_revision().clone(),
            "test-prompt",
            ClassifierRecommendation::AskUser {
                reason: "needs a person".into(),
            },
        ))
    }
}

fn review_request() -> ActionReviewRequest {
    ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"curl api.example.com"),
            ActionKind::LocalProcess(ProcessInvocationKind::Direct),
            "call the configured API",
            CapabilitySet::new([Capability::new(CapabilityKind::Network, "api.example.com")]),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
        SandboxCompatibility::Unsupported {
            reason: "network is unavailable".into(),
        },
        ActionPolicyRevision::new("policy-1"),
    )
}

#[test]
fn action_policy_service_keeps_ask_user_non_authoritative_and_builds_bound_payload() {
    let request = review_request();
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        AskClassifier,
        ash_action_policy::ReviewFailurePolicy::Block,
    );
    let engine = EnginePolicy(engine);
    let service: &dyn ActionPolicyService = &engine;
    let decision = service
        .decide(&request, &CancellationSource::new().token())
        .unwrap();
    let ExecutionDecision::AskUser(approval) = decision else {
        panic!("classifier advice must become a user approval request");
    };

    let durable = durable_approval_request(&request, &approval).unwrap();
    assert_eq!(durable.action_digest, request.action().digest().as_str());
    assert_eq!(durable.policy_revision, "policy-1");
    assert_eq!(durable.capabilities.len(), 1);
    assert_eq!(
        durable.capabilities[0].kind,
        ActionApprovalCapabilityKind::Network
    );
    assert_eq!(durable.capabilities[0].scope, "api.example.com");
}

#[test]
fn durable_approval_rejects_a_capability_set_from_another_action() {
    let request = review_request();
    let approval = ApprovalRequest::new(
        request.action().digest().clone(),
        CapabilitySet::new([Capability::new(CapabilityKind::FileWrite, "dir")]),
        "wrong capabilities",
    );

    assert_eq!(
        durable_approval_request(&request, &approval)
            .unwrap_err()
            .to_string(),
        "policy error: approval request is not bound to the reviewed action"
    );
}

#[test]
fn permission_bypass_replaces_only_a_bound_ask_user_decision() {
    let request = review_request();
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        AskClassifier,
        ash_action_policy::ReviewFailurePolicy::Block,
    );
    let engine = EnginePolicy(engine);
    let service: &dyn ActionPolicyService = &engine;

    let decision = crate::decide_turn_action(
        service,
        "policy-1",
        ApprovalMode::BypassPermissions,
        &request,
        &CancellationSource::new().token(),
    )
    .unwrap();
    let ExecutionDecision::RunWithPermissionBypass(grant) = decision else {
        panic!("permission bypass should replace the interactive approval");
    };
    assert!(grant.matches(
        request.action().digest(),
        request.action().required_capabilities(),
        request.action_policy_revision(),
    ));
}

#[test]
fn ask_permissions_keeps_the_same_action_interactive() {
    let request = review_request();
    let engine = ActionPolicyEngine::with_no_exec_rules(
        ActionPolicyRevision::new("policy-1"),
        AskClassifier,
        ash_action_policy::ReviewFailurePolicy::Block,
    );
    let engine = EnginePolicy(engine);
    let service: &dyn ActionPolicyService = &engine;

    assert!(matches!(
        crate::decide_turn_action(
            service,
            "policy-1",
            ApprovalMode::AskPermissions,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap(),
        ExecutionDecision::AskUser(_)
    ));
}

/// Adapts the policy engine for Core's execution tests.
pub(crate) struct EnginePolicy<C>(pub(crate) ActionPolicyEngine<C>);

impl<C: ActionClassifier> ActionPolicyService for EnginePolicy<C> {
    fn revision(&self) -> String {
        self.0.revision().as_str().to_owned()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        self.0
            .decide(request, cancellation)
            .map_err(|error| CoreError::Policy(error.to_string()))
    }
}
