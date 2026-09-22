use super::*;
use action_policy::{
    ActionClassifier, ActionDigest, ActionKind, ActionPolicyRevision, ActionProvenance,
    ActionReviewRequest, ActionSource, Capability, CapabilityKind, CapabilitySet,
    ClassifierRecommendation, ProcessInvocationKind, ResolvedAction, SandboxCompatibility,
};
use async_utils::CancellationSource;

struct StaticModel(&'static str);

#[test]
fn model_receives_bounded_history_without_losing_user_authority_or_action() {
    use action_policy::ReviewContext;
    use action_policy::ReviewEvidence;
    use action_policy::ReviewEvidenceKind;
    use action_policy::ReviewEvidenceTrust;
    struct Inspect;
    impl ReviewModel for Inspect {
        fn complete(
            &self,
            request: &ReviewModelRequest,
            _: &async_utils::CancellationToken,
        ) -> Result<String, ReviewModelError> {
            let input: serde_json::Value = serde_json::from_str(request.input_json()).unwrap();
            assert_eq!(
                input["context"]["user_intent"],
                "Inspect only; do not publish."
            );
            assert_eq!(input["context"]["omitted_evidence"], 1);
            assert_eq!(
                input["context"]["evidence"][0]["content"],
                "Inspect only; do not publish."
            );
            assert_eq!(
                input["context"]["evidence"][1]["content"],
                "prepared payload"
            );
            assert!(request.input_json().contains("call the configured API"));
            assert!(
                request.input_json().len()
                    + request.system_prompt().len()
                    + request.response_schema_json().len()
                    <= MAX_MODEL_INPUT_TOKENS * 3
            );
            Ok(r#"{"recommendation":"deny","reason":"inspection only"}"#.into())
        }
    }
    let context = ReviewContext::new(
        "Inspect only; do not publish.",
        [
            ReviewEvidence::new(
                ReviewEvidenceKind::PriorToolResult,
                ReviewEvidenceTrust::UntrustedContent,
                "tool",
                "x".repeat(MAX_MODEL_INPUT_BYTES),
            ),
            ReviewEvidence::new(
                ReviewEvidenceKind::UserMessage,
                ReviewEvidenceTrust::TrustedUser,
                "user",
                "Inspect only; do not publish.",
            ),
            ReviewEvidence::new(
                ReviewEvidenceKind::PreparedAction,
                ReviewEvidenceTrust::TrustedHost,
                "action",
                "prepared payload",
            ),
        ],
    );
    LlmActionClassifier::new(Inspect)
        .classify(
            &request(SandboxCompatibility::NotApplicable {
                reason: "remote API".into(),
            })
            .with_context(context),
            &CancellationSource::new().token(),
        )
        .unwrap();
}

#[test]
fn model_input_distinguishes_managed_network_from_unrestricted_network() {
    let request = request(SandboxCompatibility::Supported(
        sandboxing::SandboxPolicy::new(
            sandboxing::FileSystemAccess::DirectoryWrite,
            sandboxing::NetworkAccess::Managed,
        ),
    ));
    let input: serde_json::Value = serde_json::from_str(
        &crate::protocol::input_with_context(&request, request.context()).unwrap(),
    )
    .unwrap();
    assert_eq!(input["sandbox"]["network"], "managed_proxy");
}

impl ReviewModel for StaticModel {
    fn complete(
        &self,
        _: &ReviewModelRequest,
        _: &async_utils::CancellationToken,
    ) -> Result<String, ReviewModelError> {
        Ok(self.0.to_owned())
    }
}

struct OwnedModel(String);

impl ReviewModel for OwnedModel {
    fn complete(
        &self,
        _: &ReviewModelRequest,
        _: &async_utils::CancellationToken,
    ) -> Result<String, ReviewModelError> {
        Ok(self.0.clone())
    }
}

struct CancellingModel(CancellationSource);

impl ReviewModel for CancellingModel {
    fn complete(
        &self,
        _: &ReviewModelRequest,
        _: &async_utils::CancellationToken,
    ) -> Result<String, ReviewModelError> {
        self.0.cancel();
        Err(ReviewModelError::Invocation(
            "provider observed cancellation".to_owned(),
        ))
    }
}

struct ContractCheckingModel;

impl ReviewModel for ContractCheckingModel {
    fn complete(
        &self,
        request: &ReviewModelRequest,
        _: &async_utils::CancellationToken,
    ) -> Result<String, ReviewModelError> {
        serde_json::from_str::<serde_json::Value>(request.response_schema_json()).unwrap();
        assert_eq!(request.maximum_response_bytes(), MAX_MODEL_RESPONSE_BYTES);
        Ok(r#"{"recommendation":"deny","reason":"unsafe"}"#.to_owned())
    }
}

struct SandboxDenialInputCheckingModel;

impl ReviewModel for SandboxDenialInputCheckingModel {
    fn complete(
        &self,
        request: &ReviewModelRequest,
        _: &async_utils::CancellationToken,
    ) -> Result<String, ReviewModelError> {
        let input: serde_json::Value = serde_json::from_str(request.input_json()).unwrap();
        assert_eq!(input["phase"]["kind"], "sandbox_denial");
        assert_eq!(
            input["phase"]["detail"]["reason"],
            "network access was denied"
        );
        assert_eq!(
            input["phase"]["detail"]["output"],
            "connect: operation not permitted"
        );
        Ok(r#"{"recommendation":"deny","reason":"test"}"#.to_owned())
    }
}

fn request(sandbox: SandboxCompatibility) -> ActionReviewRequest {
    request_with_summary(sandbox, "call the configured API")
}

fn request_with_summary(
    sandbox: SandboxCompatibility,
    summary: impl Into<String>,
) -> ActionReviewRequest {
    let capability = Capability::new(CapabilityKind::Network, "api.example.com");
    ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"curl api.example.com"),
            ActionKind::LocalProcess(ProcessInvocationKind::Direct),
            summary,
            CapabilitySet::new([capability]),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "shell-command"),
        sandbox,
        ActionPolicyRevision::new("policy-7"),
    )
}

#[test]
fn binds_model_advice_to_the_host_action_and_action_policy_revision() {
    let model = StaticModel(
        r#"{
            "recommendation":"approve",
            "capabilities":[{"kind":"network","scope":"api.example.com"}],
            "risk":"medium",
            "user_authorization":"implicit",
            "reason":"the action requires the configured API"
        }"#,
    );
    let classifier = LlmActionClassifier::new(model);
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    let assessment = classifier
        .classify(&request, &CancellationSource::new().token())
        .unwrap();

    assert_eq!(assessment.action_digest(), request.action().digest());
    assert_eq!(
        assessment.action_policy_revision(),
        request.action_policy_revision()
    );
    assert_eq!(assessment.review_protocol_revision(), "review-protocol-5");
    assert!(matches!(
        assessment.recommendation(),
        ClassifierRecommendation::Approve { .. }
    ));
}

#[test]
fn identical_assessments_receive_the_same_audit_identity() {
    let classifier = LlmActionClassifier::new(StaticModel(
        r#"{"recommendation":"deny","reason":"unsafe"}"#,
    ));
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    let first = classifier
        .classify(&request, &CancellationSource::new().token())
        .unwrap();
    let second = classifier
        .classify(&request, &CancellationSource::new().token())
        .unwrap();

    assert_eq!(first.assessment_id(), second.assessment_id());
    assert_eq!(first.assessment_id().as_str().len(), 64);
}

#[test]
fn semantically_identical_responses_receive_the_same_audit_identity() {
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });
    let compact = LlmActionClassifier::new(StaticModel(
        r#"{"recommendation":"deny","reason":"unsafe"}"#,
    ))
    .classify(&request, &CancellationSource::new().token())
    .unwrap();
    let reordered = LlmActionClassifier::new(StaticModel(
        r#"{ "reason": "unsafe", "recommendation": "deny" }"#,
    ))
    .classify(&request, &CancellationSource::new().token())
    .unwrap();

    assert_eq!(compact.assessment_id(), reordered.assessment_id());
}

#[test]
fn model_request_exposes_a_valid_schema_and_response_budget() {
    let classifier = LlmActionClassifier::new(ContractCheckingModel);
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    classifier
        .classify(&request, &CancellationSource::new().token())
        .unwrap();
}

#[test]
fn model_request_identifies_review_after_a_confirmed_sandbox_denial() {
    let classifier = LlmActionClassifier::new(SandboxDenialInputCheckingModel);
    let request = request(SandboxCompatibility::Supported(
        sandboxing::SandboxPolicy::new(
            sandboxing::FileSystemAccess::ReadOnly,
            sandboxing::NetworkAccess::Denied,
        ),
    ))
    .after_sandbox_denial(action_policy::SandboxDenialEvidence::new(
        "network access was denied",
        "connect: operation not permitted",
    ));

    classifier
        .classify(&request, &CancellationSource::new().token())
        .unwrap();
}

#[test]
fn rejects_capabilities_not_present_in_the_resolved_action() {
    let model = StaticModel(
        r#"{
            "recommendation":"approve",
            "capabilities":[{"kind":"system_configuration","scope":"host"}],
            "risk":"medium",
            "user_authorization":"implicit",
            "reason":"change the host"
        }"#,
    );
    let classifier = LlmActionClassifier::new(model);
    let request = request(SandboxCompatibility::Unsupported {
        reason: "not supported".to_owned(),
    });

    assert!(matches!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::InvalidResponse(_))
    ));
}

#[test]
fn rejects_incomplete_approval_recommendation() {
    let model = StaticModel(r#"{"recommendation":"approve","reason":"missing fields"}"#);
    let classifier = LlmActionClassifier::new(model);
    let request = request(SandboxCompatibility::NotApplicable {
        reason: "external mutation".to_owned(),
    });

    assert!(matches!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::InvalidResponse(_))
    ));
}

#[test]
fn rejects_unknown_response_fields_instead_of_ignoring_them() {
    let model = StaticModel(
        r#"{
            "recommendation":"deny",
            "reason":"unsafe",
            "authorization":"granted"
        }"#,
    );
    let classifier = LlmActionClassifier::new(model);
    let request = request(SandboxCompatibility::Unsupported {
        reason: "not supported".to_owned(),
    });

    assert!(matches!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::InvalidResponse(_))
    ));
}

#[test]
fn cancellation_prevents_the_review_model_from_starting() {
    let classifier = LlmActionClassifier::new(StaticModel(
        r#"{"recommendation":"deny","reason":"unused"}"#,
    ));
    let source = CancellationSource::new();
    source.cancel();
    let request = request(SandboxCompatibility::Unsupported {
        reason: "not supported".to_owned(),
    });

    assert_eq!(
        classifier.classify(&request, &source.token()),
        Err(AutoReviewError::Cancelled)
    );
}

#[test]
fn rejects_unknown_fields_inside_capabilities() {
    let classifier = LlmActionClassifier::new(StaticModel(
        r#"{
            "recommendation":"approve",
            "capabilities":[{
                "kind":"network",
                "scope":"api.example.com",
                "grant":true
            }],
            "risk":"medium",
            "user_authorization":"implicit",
            "reason":"the action requires the configured API"
        }"#,
    ));
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    assert!(matches!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::InvalidResponse(_))
    ));
}

#[test]
fn rejects_revised_capabilities_that_broaden_the_action() {
    let classifier = LlmActionClassifier::new(StaticModel(
        r#"{
            "recommendation":"revise_action",
            "maximum_capabilities":[{
                "kind":"system_configuration",
                "scope":"host"
            }],
            "reason":"change the host instead"
        }"#,
    ));
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    assert!(matches!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::InvalidResponse(_))
    ));
}

#[test]
fn cancellation_during_model_completion_is_not_reported_as_a_model_failure() {
    let source = CancellationSource::new();
    let classifier = LlmActionClassifier::new(CancellingModel(source.clone()));
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    assert_eq!(
        classifier.classify(&request, &source.token()),
        Err(AutoReviewError::Cancelled)
    );
}

#[test]
fn rejects_oversized_model_input_before_invocation() {
    let classifier = LlmActionClassifier::new(StaticModel(
        r#"{"recommendation":"deny","reason":"unused"}"#,
    ));
    let request = request_with_summary(
        SandboxCompatibility::Unsupported {
            reason: "network is unavailable".to_owned(),
        },
        "x".repeat(MAX_MODEL_INPUT_BYTES + 1),
    );

    assert!(matches!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::RequestTooLarge { .. })
    ));
}

#[test]
fn rejects_oversized_model_output() {
    let classifier = LlmActionClassifier::new(OwnedModel("x".repeat(MAX_MODEL_RESPONSE_BYTES + 1)));
    let request = request(SandboxCompatibility::Unsupported {
        reason: "network is unavailable".to_owned(),
    });

    assert_eq!(
        classifier.classify(&request, &CancellationSource::new().token()),
        Err(AutoReviewError::ResponseTooLarge {
            bytes: MAX_MODEL_RESPONSE_BYTES + 1
        })
    );
}
