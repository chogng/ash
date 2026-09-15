use super::*;
use action_policy::ActionClassifier;
use action_policy::ActionDigest;
use action_policy::ActionKind;
use action_policy::ActionPolicyRevision;
use action_policy::ActionProvenance;
use action_policy::ActionReviewRequest;
use action_policy::ActionSource;
use action_policy::Capability;
use action_policy::CapabilityKind;
use action_policy::CapabilitySet;
use action_policy::ExecutionDecision;
use action_policy::ProcessInvocationKind;
use action_policy::ResolvedAction;
use action_policy::ReviewContext;
use action_policy::SandboxCompatibility;
use async_utils::CancellationSource;
use core_api::ActionPolicyService;
use core_api::CoreError;
use guardian_reviewer::AutoReviewError;
use guardian_reviewer::LlmActionClassifier;
use model_provider::ModelProviderError;
use model_provider_config::ApiProfile;
use model_provider_config::EndpointPolicy;
use model_provider_config::Model;
use model_provider_config::ModelCatalogPolicy;
use model_provider_config::ModelId;
use model_provider_config::ModelProviderConfig;
use model_provider_config::ProviderAdapter;
use model_provider_config::ProviderDefinition;
use model_provider_config::ProviderId;
use protocol::ApprovalMode;
use protocol::ContentPart;
use protocol::InputItem;
use protocol::ModelResponse;
use protocol::StopReason;
use std::collections::BTreeMap;
use std::sync::Mutex;

struct RecordingProvider {
    selected: Arc<Mutex<Vec<ModelRef>>>,
    requests: Arc<Mutex<Vec<ModelRequest>>>,
}

impl ModelProvider for RecordingProvider {
    fn runtime(
        &self,
        request: ModelRuntimeRequest,
    ) -> Result<Arc<dyn ModelInvoker>, ModelProviderError> {
        self.selected.lock().unwrap().push(request.model);
        Ok(Arc::new(RecordingInvoker {
            requests: self.requests.clone(),
        }))
    }
}

struct RecordingInvoker {
    requests: Arc<Mutex<Vec<ModelRequest>>>,
}

impl ModelInvoker for RecordingInvoker {
    fn output_transport(&self) -> protocol::ModelOutputTransport {
        protocol::ModelOutputTransport::Unary
    }

    fn stream_with_cancellation(
        &self,
        request: &ModelRequest,
        _: &async_utils::CancellationToken,
        _: &mut dyn model_provider::ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(
                r#"{"recommendation":"deny","reason":"unsafe"}"#.into(),
            )],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

struct StaticResponseInvoker(String);

impl ModelInvoker for StaticResponseInvoker {
    fn output_transport(&self) -> protocol::ModelOutputTransport {
        protocol::ModelOutputTransport::Unary
    }

    fn stream_with_cancellation(
        &self,
        _: &ModelRequest,
        _: &async_utils::CancellationToken,
        _: &mut dyn model_provider::ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        Ok(ModelResponse {
            output: vec![ResponseItem::Text(self.0.clone())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}

fn model_ref(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(provider_id(provider), ModelId::new(model).unwrap())
}

fn registry() -> ProviderConfigRegistry {
    ProviderConfigRegistry::from_definitions([ProviderDefinition::new(
        provider_id("test"),
        "Test",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
        EndpointPolicy::ProviderDefault {
            base_url: "https://example.test/v1".into(),
        },
        ModelCatalogPolicy::ListedOnly,
    )
    .with_default_model(Model::new(
        ModelId::new("review-model").unwrap(),
        "Reviewer",
    ))])
    .unwrap()
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
    .with_context(ReviewContext::new(
        "call the configured API for this task",
        [],
    ))
}

#[test]
fn automatic_review_resolves_provider_default_and_uses_a_review_only_request() {
    let selected = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let resolver = ReviewModelResolver::new(
        registry(),
        Arc::new(RecordingProvider {
            selected: selected.clone(),
            requests: requests.clone(),
        }),
    );
    let config = ResolvedConfig {
        model: Some(model_ref("test", "agent-model")),
        providers: BTreeMap::from([(
            provider_id("test"),
            ModelProviderConfig::new(provider_id("test")),
        )]),
        ..ResolvedConfig::default()
    };

    let reviewer = resolver.resolve(&config).unwrap();
    assert_eq!(reviewer.model(), &model_ref("test", "review-model"));
    let classifier = LlmActionClassifier::new(reviewer);
    classifier
        .classify(&review_request(), &CancellationSource::new().token())
        .unwrap();

    assert_eq!(
        selected.lock().unwrap().as_slice(),
        &[model_ref("test", "review-model")]
    );
    let requests = requests.lock().unwrap();
    let request = requests.first().unwrap();
    assert!(request.tools.is_empty());
    assert_eq!(request.tool_choice, ToolChoice::None);
    assert!(!request.parallel_tool_calls);
    let instructions = request.instructions.as_deref().unwrap();
    assert!(instructions.contains("security review classifier"));
    assert!(instructions.contains("response schema"));
    let InputItem::Message(message) = &request.input[0] else {
        panic!("review input must be a user message");
    };
    let ContentPart::Text(input) = &message.content[0] else {
        panic!("review input must be text");
    };
    assert!(input.contains("\"policy_revision\":\"policy-1\""));
    assert!(input.contains("\"user_intent\":\"call the configured API for this task\""));
}

#[test]
fn review_adapter_enforces_the_classifier_response_budget_while_collecting_text() {
    let reviewer = ProviderReviewModel {
        model: model_ref("test", "review-model"),
        invoker: Arc::new(StaticResponseInvoker("x".repeat(20 * 1024))),
    };
    let classifier = LlmActionClassifier::new(reviewer);

    assert!(matches!(
        classifier.classify(&review_request(), &CancellationSource::new().token()),
        Err(AutoReviewError::ResponseTooLarge { .. })
    ));
}

#[test]
fn explicit_review_rejects_a_model_outside_a_listed_catalog() {
    let resolver = ReviewModelResolver::new(
        registry(),
        Arc::new(RecordingProvider {
            selected: Arc::new(Mutex::new(Vec::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
        }),
    );
    let config = ResolvedConfig {
        approval_review_model: config::ApprovalReviewModelSelection::Explicit {
            model: model_ref("test", "missing"),
        },
        providers: BTreeMap::from([(
            provider_id("test"),
            ModelProviderConfig::new(provider_id("test")),
        )]),
        ..ResolvedConfig::default()
    };

    assert_eq!(
        resolver.resolve(&config).err().unwrap().to_string(),
        "model 'missing' is not registered for provider 'test'"
    );
}

struct AskPolicy;

impl ActionPolicyService for AskPolicy {
    fn revision(&self) -> String {
        "base-policy-v1".into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::AskUser(
            action_policy::ApprovalRequest::new(
                request.action().digest().clone(),
                request.action().required_capabilities().clone(),
                "needs approval",
            ),
        ))
    }
}

#[test]
fn approval_mode_policy_runs_the_reviewer_only_for_auto_review() {
    let review_model = ProviderReviewModel {
        model: model_ref("test", "review-model"),
        invoker: Arc::new(StaticResponseInvoker(
            r#"{"recommendation":"deny","reason":"unsafe"}"#.into(),
        )),
    };
    let policy = ash_core::TurnActionPolicy::new(
        Arc::new(AskPolicy),
        crate::reviewer(review_model),
    );
    let revision = policy.revision();
    let request = review_request();

    assert!(matches!(
        ash_core::decide_turn_action(
            &policy,
            &revision,
            ApprovalMode::AskPermissions,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap(),
        ExecutionDecision::AskUser(_)
    ));
    assert!(matches!(
        ash_core::decide_turn_action(
            &policy,
            &revision,
            ApprovalMode::AutoReview,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap(),
        ExecutionDecision::Block(_)
    ));
    assert!(matches!(
        ash_core::decide_turn_action(
            &policy,
            &revision,
            ApprovalMode::BypassPermissions,
            &request,
            &CancellationSource::new().token(),
        )
        .unwrap(),
        ExecutionDecision::RunWithPermissionBypass(_)
    ));
}

#[test]
fn code_mode_control_grants_only_the_isolated_runtime_capability() {
    let policy = ash_core::TurnActionPolicy::new(
        Arc::new(AskPolicy),
        extension_api::ApprovalReviewer::Unavailable,
    );
    let request = |revision: String, capability: Capability| {
        ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(b"code-mode-test"),
                ActionKind::SystemOperation,
                "Code Mode",
                CapabilitySet::new([capability]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, "code-mode"),
            SandboxCompatibility::NotApplicable {
                reason: "isolated runtime".into(),
            },
            ActionPolicyRevision::new(revision),
        )
    };
    let cancellation = CancellationSource::new();
    let control = request(
        policy.revision(),
        Capability::new(CapabilityKind::SystemConfiguration, "code-mode"),
    );
    assert!(matches!(
        policy.decide(&control, &cancellation.token()),
        Ok(ExecutionDecision::RunUnsandboxed { .. })
    ));
    let write = request(
        policy.revision(),
        Capability::new(CapabilityKind::FileWrite, "/tmp"),
    );
    assert!(matches!(
        policy.decide(&write, &cancellation.token()),
        Err(CoreError::Policy(_))
    ));
    let stale = request(
        "old-policy".into(),
        Capability::new(CapabilityKind::SystemConfiguration, "code-mode"),
    );
    assert!(matches!(
        policy.decide(&stale, &cancellation.token()),
        Err(CoreError::Policy(_))
    ));
    cancellation.cancel();
    assert!(matches!(
        policy.decide(&control, &cancellation.token()),
        Err(CoreError::Cancelled(_))
    ));
}
