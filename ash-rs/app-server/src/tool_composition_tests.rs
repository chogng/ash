use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_config::ToolSearchModeConfig;
use core_api::ActionPolicyService;
use core_api::CoreError;
use ash_core::ProcessExecutionOutput;
use ash_core::ProcessExitStatus;
use ash_core::SandboxDenialOutput;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputStream;
use ash_tools::ToolExposure;

use super::CombinedToolPorts;
use super::ReloadableToolPorts;
use super::ToolPort;
use super::ToolSearchOptions;
use super::combine_tool_ports;
use super::combine_tool_ports_at_generation;
use super::combine_tool_ports_at_generation_with_search;

struct FakeTools {
    definitions: Vec<ToolDefinition>,
    source: ActionSource,
    source_id: &'static str,
}

impl FakeTools {
    fn new(name: &str, source: ActionSource, source_id: &'static str) -> Self {
        Self {
            definitions: vec![ToolDefinition {
                name: ToolName::new(name).unwrap(),
                description: name.into(),
                parameters: serde_json::json!({"type": "object"}),
                strict: false,
            }],
            source,
            source_id,
        }
    }

    fn catalog(prefix: &str, count: usize, source: ActionSource, source_id: &'static str) -> Self {
        Self {
            definitions: (0..count)
                .map(|index| ToolDefinition {
                    name: ToolName::new(format!("{prefix}_{index}")).unwrap(),
                    description: format!("External capability number {index}"),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {}
                    }),
                    strict: false,
                })
                .collect(),
            source,
            source_id,
        }
    }
}

impl ToolService for FakeTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(self.source_id),
                ActionKind::ExternalServiceMutation,
                self.source_id,
                CapabilitySet::new([Capability::new(
                    CapabilityKind::ExternalMutation,
                    self.source_id,
                )]),
            ),
            ActionProvenance::new(self.source.clone(), self.source_id),
            SandboxCompatibility::NotApplicable {
                reason: "test".into(),
            },
            ActionPolicyRevision::new("test"),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Ok(ToolExecutionOutput::Success(self.source_id.into()))
    }
}

#[test]
fn small_mcp_catalog_is_exposed_directly() {
    let combined = combine_tool_ports(vec![
        ToolPort::local(
            Arc::new(FakeTools::new(
                "read_file",
                ActionSource::BuiltInTool,
                "local",
            )),
            Arc::new(AskPolicy),
        ),
        ToolPort::mcp(
            Arc::new(FakeTools::new(
                "external_status",
                ActionSource::McpServer,
                "user:mcp:test",
            )),
            Arc::new(AskPolicy),
        ),
    ])
    .unwrap()
    .unwrap();

    let visible = combined
        .tools
        .model_definitions(&std::collections::BTreeSet::new())
        .unwrap();

    assert_eq!(
        visible
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["external_status", "read_file"]
    );
}

#[test]
fn one_tool_can_override_its_source_default_exposure() {
    let external = ToolName::new("external_status").unwrap();
    let mcp = ToolPort::mcp(
        Arc::new(FakeTools::new(
            external.as_str(),
            ActionSource::McpServer,
            "user:mcp:test",
        )),
        Arc::new(AskPolicy),
    )
    .with_tool_exposure(&external, ToolExposure::Direct)
    .unwrap();
    let combined = combine_tool_ports(vec![mcp]).unwrap().unwrap();

    let visible = combined
        .tools
        .model_definitions(&std::collections::BTreeSet::new())
        .unwrap();

    assert_eq!(
        visible
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["external_status"]
    );
}

#[test]
fn large_mcp_catalog_uses_a_fixed_search_and_call_surface() {
    let combined = combine_tool_ports_at_generation(
        vec![
            ToolPort::local(
                Arc::new(FakeTools::new(
                    "read_file",
                    ActionSource::BuiltInTool,
                    "local",
                )),
                Arc::new(AskPolicy),
            ),
            ToolPort::mcp(
                Arc::new(FakeTools::catalog(
                    "external",
                    20,
                    ActionSource::McpServer,
                    "user:mcp:test",
                )),
                Arc::new(AskPolicy),
            ),
        ],
        ash_tools::ToolRegistryGeneration::new(7),
    )
    .unwrap()
    .unwrap();

    let initial = combined
        .tools
        .model_definitions(&std::collections::BTreeSet::new())
        .unwrap();
    assert_eq!(
        initial
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["call_mcp_tool", "read_file", "search_tools"]
    );

    let search_call = ToolCall {
        id: ash_protocol::ToolCallId::new("search-call").unwrap(),
        name: ToolName::new("search_tools").unwrap(),
        arguments: serde_json::json!({
            "query": "external capability number 17"
        }),
    };
    let review = combined.tools.prepare(&search_call).unwrap();
    let ExecutionDecision::RunUnsandboxed { grant_id } = combined
        .policy
        .decide(
            &review,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("tool search must receive the internal read-only grant");
    };
    let ToolExecutionOutput::Success(output) = combined
        .tools
        .execute(
            &search_call,
            &ToolAuthorization::UnsandboxedGrant { grant_id },
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("tool search must return a successful result");
    };
    let next = combined
        .tools
        .model_definitions(&std::collections::BTreeSet::new())
        .unwrap();
    assert_eq!(
        next.iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["call_mcp_tool", "read_file", "search_tools"]
    );
    let output = serde_json::from_str::<serde_json::Value>(&output).unwrap();
    assert_eq!(output["tools"].as_array().unwrap().len(), 5);
    assert_eq!(output["tools"][0]["name"], "external_17");
}

enum TestEmbeddingBehavior {
    RankExternalSeventeen,
    Fail,
    FailAfterProbe,
}

struct TestEmbedding {
    behavior: TestEmbeddingBehavior,
    calls: Arc<AtomicUsize>,
}

impl EmbeddingInvoker for TestEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.behavior, TestEmbeddingBehavior::Fail)
            || matches!(self.behavior, TestEmbeddingBehavior::FailAfterProbe) && call > 0
        {
            return Err(ModelProviderError::Unavailable(
                "test embedding unavailable".into(),
            ));
        }
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|input| {
                    let values =
                        if input.contains("arrange appointment") || input.contains("external_17") {
                            vec![1.0, 0.0]
                        } else {
                            vec![0.0, 1.0]
                        };
                    EmbeddingVector::new(values)
                })
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

fn external_catalog() -> Vec<ToolPort> {
    let mut port = ToolPort::dynamic(
        Arc::new(FakeTools::catalog(
            "external",
            21,
            ActionSource::DynamicTool,
            "test:dynamic",
        )),
        Arc::new(AskPolicy),
    );
    for index in 0..21 {
        port = port
            .with_tool_exposure(
                &ToolName::new(format!("external_{index}")).unwrap(),
                ToolExposure::Deferred,
            )
            .unwrap();
    }
    vec![port]
}

fn try_execute_search(
    combined: &CombinedToolPorts,
    query: &str,
    strategy: &str,
) -> Result<Vec<String>, CoreError> {
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new(format!("search-{strategy}")).unwrap(),
        name: ToolName::new("tool_search").unwrap(),
        arguments: serde_json::json!({
            "query": query,
            "limit": 1,
            "strategy": strategy
        }),
    };
    let review = combined.tools.prepare(&call).unwrap();
    let ExecutionDecision::RunUnsandboxed { grant_id } = combined
        .policy
        .decide(
            &review,
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("tool search must receive a grant");
    };
    let output = combined.tools.execute(
        &call,
        &ToolAuthorization::UnsandboxedGrant { grant_id },
        &ash_async_utils::CancellationSource::new().token(),
    )?;
    let ToolExecutionOutput::Success(output) = output else {
        return Err(CoreError::Execution(
            "tool search returned failure output".into(),
        ));
    };
    Ok(
        serde_json::from_str::<serde_json::Value>(&output).unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect(),
    )
}

fn execute_search(combined: &CombinedToolPorts, query: &str, strategy: &str) -> Vec<String> {
    try_execute_search(combined, query, strategy).unwrap()
}

#[test]
fn lexical_mode_never_invokes_an_available_embedding_model() {
    let calls = Arc::new(AtomicUsize::new(0));
    let embedding = Arc::new(TestEmbedding {
        behavior: TestEmbeddingBehavior::RankExternalSeventeen,
        calls: Arc::clone(&calls),
    });
    let options = ToolSearchOptions::new().with_embedding(embedding).unwrap();
    let combined = combine_tool_ports_at_generation_with_search(
        external_catalog(),
        ash_tools::ToolRegistryGeneration::new(1),
        options,
    )
    .unwrap()
    .unwrap();

    assert_eq!(
        execute_search(&combined, "external capability number 17", "bm25"),
        vec!["external_17"]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn hybrid_mode_adds_embedding_recall_to_the_lexical_ranking() {
    let calls = Arc::new(AtomicUsize::new(0));
    let embedding = Arc::new(TestEmbedding {
        behavior: TestEmbeddingBehavior::RankExternalSeventeen,
        calls: Arc::clone(&calls),
    });
    let options = ToolSearchOptions::new()
        .with_embedding(embedding)
        .unwrap()
        .with_mode(ToolSearchModeConfig::HybridEmbedding)
        .unwrap();
    let combined = combine_tool_ports_at_generation_with_search(
        external_catalog(),
        ash_tools::ToolRegistryGeneration::new(1),
        options,
    )
    .unwrap()
    .unwrap();

    assert_eq!(
        execute_search(&combined, "arrange appointment", "bm25"),
        vec!["external_17"]
    );
    assert!(calls.load(Ordering::SeqCst) >= 3);
}

#[test]
fn hybrid_mode_gate_rejects_a_missing_or_unavailable_embedding_adapter() {
    let missing = ToolSearchOptions::new()
        .with_mode(ToolSearchModeConfig::HybridEmbedding)
        .err()
        .unwrap();
    assert!(
        missing
            .to_string()
            .contains("requires an installed embedding")
    );

    let calls = Arc::new(AtomicUsize::new(0));
    let embedding = Arc::new(TestEmbedding {
        behavior: TestEmbeddingBehavior::Fail,
        calls: Arc::clone(&calls),
    });
    let error = ToolSearchOptions::new()
        .with_embedding(embedding)
        .unwrap()
        .with_mode(ToolSearchModeConfig::HybridEmbedding)
        .err()
        .unwrap();

    assert!(error.to_string().contains("readiness probe failed"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn enabled_hybrid_mode_reports_runtime_embedding_failure_without_fallback() {
    let calls = Arc::new(AtomicUsize::new(0));
    let embedding = Arc::new(TestEmbedding {
        behavior: TestEmbeddingBehavior::FailAfterProbe,
        calls: Arc::clone(&calls),
    });
    let options = ToolSearchOptions::new()
        .with_embedding(embedding)
        .unwrap()
        .with_mode(ToolSearchModeConfig::HybridEmbedding)
        .unwrap();
    let combined = combine_tool_ports_at_generation_with_search(
        external_catalog(),
        ash_tools::ToolRegistryGeneration::new(1),
        options,
    )
    .unwrap()
    .unwrap();

    let error = try_execute_search(&combined, "external capability number 17", "bm25").unwrap_err();
    assert!(
        error
            .to_string()
            .contains("hybrid embedding tool search is unavailable")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn unavailable_persisted_hybrid_mode_does_not_silently_fallback_to_bm25() {
    let combined = combine_tool_ports_at_generation_with_search(
        external_catalog(),
        ash_tools::ToolRegistryGeneration::new(1),
        ToolSearchOptions::unavailable("configured embedding model is offline"),
    )
    .unwrap()
    .unwrap();

    let error = try_execute_search(&combined, "external capability number 17", "bm25")
        .expect_err("enabled hybrid mode must fail closed when its model is unavailable");
    assert!(
        error
            .to_string()
            .contains("configured embedding model is offline")
    );
    assert_eq!(
        execute_search(&combined, "external_17", "regex"),
        vec!["external_17"]
    );
}

struct AskPolicy;

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
            "test",
        )))
    }
}

struct FactsAwareTools {
    definition: ToolDefinition,
}

struct SandboxThenSuccessTools {
    definition: ToolDefinition,
    result: &'static str,
    calls: AtomicUsize,
}

impl ToolService for SandboxThenSuccessTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![self.definition.clone()]
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        fake_review(ActionSource::BuiltInTool, self.result)
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(ToolExecutionOutput::SandboxDenied(
                SandboxDenialOutput::safe_to_retry(
                    "test denial",
                    ProcessExecutionOutput::from_captured_streams(
                        ProcessExitStatus::Code(1),
                        "",
                        "denied",
                    ),
                ),
            ));
        }
        Ok(ToolExecutionOutput::Success(self.result.into()))
    }
}

impl ToolService for FactsAwareTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![self.definition.clone()]
    }

    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        fake_review(ActionSource::BuiltInTool, "facts-aware")
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Ok(ToolExecutionOutput::Success("facts-dropped".into()))
    }

    fn execute_streaming_with_facts(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
        _: &ToolExecutionFacts,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Ok(ToolExecutionOutput::Success("facts-preserved".into()))
    }
}

struct TestSink;

impl ToolOutputSink for TestSink {
    fn emit(&mut self, _: ToolOutputStream, _: String) -> Result<(), CoreError> {
        Ok(())
    }
}

fn fake_review(
    source: ActionSource,
    source_id: &'static str,
) -> Result<ActionReviewRequest, CoreError> {
    Ok(ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(source_id.as_bytes()),
            ActionKind::SystemOperation,
            source_id,
            CapabilitySet::new([]),
        ),
        ActionProvenance::new(source, source_id),
        SandboxCompatibility::NotApplicable {
            reason: "test".into(),
        },
        ActionPolicyRevision::new("test"),
    ))
}

#[test]
fn routes_tool_and_policy_by_frozen_definition_and_provenance() {
    let combined = combine_tool_ports(vec![
        ToolPort::local(
            Arc::new(FakeTools::new(
                "local_tool",
                ActionSource::BuiltInTool,
                "local",
            )),
            Arc::new(AskPolicy),
        ),
        ToolPort::mcp(
            Arc::new(FakeTools::new(
                "mcp_tool",
                ActionSource::McpServer,
                "user:mcp:test",
            )),
            Arc::new(AskPolicy),
        ),
    ])
    .unwrap()
    .unwrap();
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("call-1").unwrap(),
        name: ToolName::new("mcp_tool").unwrap(),
        arguments: serde_json::json!({}),
    };

    let review = combined.tools.prepare(&call).expect("route tool");
    assert_eq!(review.provenance().source(), &ActionSource::McpServer);
    assert!(matches!(
        combined
            .policy
            .decide(
                &review,
                &ash_async_utils::CancellationSource::new().token()
            )
            .expect("route policy"),
        ExecutionDecision::AskUser(_)
    ));
}

#[test]
fn durable_binding_rejects_same_named_tool_from_a_new_generation() {
    let initial = combine_tool_ports_at_generation(
        vec![ToolPort::local(
            Arc::new(FakeTools::new(
                "shared_tool",
                ActionSource::BuiltInTool,
                "initial",
            )),
            Arc::new(AskPolicy),
        )],
        ash_tools::ToolRegistryGeneration::new(3),
    )
    .unwrap()
    .unwrap();
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("durable-call").unwrap(),
        name: ToolName::new("shared_tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    let binding = initial
        .tools
        .bind_call(&call, ash_protocol::ToolCallCaller::Direct)
        .unwrap()
        .unwrap();
    assert_eq!(binding.registry_generation, 3);
    initial
        .tools
        .validate_call_binding(&call, Some(&binding))
        .unwrap();

    let replacement = combine_tool_ports_at_generation(
        vec![ToolPort::local(
            Arc::new(FakeTools::new(
                "shared_tool",
                ActionSource::BuiltInTool,
                "replacement",
            )),
            Arc::new(AskPolicy),
        )],
        ash_tools::ToolRegistryGeneration::new(4),
    )
    .unwrap()
    .unwrap();

    assert!(
        replacement
            .tools
            .validate_call_binding(&call, Some(&binding))
            .unwrap_err()
            .to_string()
            .contains("no longer matches")
    );
}

#[test]
fn rejects_duplicate_model_tool_names() {
    let result = combine_tool_ports(vec![
        ToolPort::local(
            Arc::new(FakeTools::new(
                "duplicate",
                ActionSource::BuiltInTool,
                "local",
            )),
            Arc::new(AskPolicy),
        ),
        ToolPort::mcp(
            Arc::new(FakeTools::new(
                "duplicate",
                ActionSource::McpServer,
                "user:mcp:test",
            )),
            Arc::new(AskPolicy),
        ),
    ]);

    assert!(result.is_err());
}

#[test]
fn reload_switches_future_calls_but_preserves_prepared_call_generation() {
    let initial = combine_tool_ports(vec![ToolPort::local(
        Arc::new(FakeTools::new(
            "shared_tool",
            ActionSource::BuiltInTool,
            "initial",
        )),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    let reloadable = ReloadableToolPorts::new(initial);
    let tools = reloadable.tools();
    let prepared = ToolCall {
        id: ash_protocol::ToolCallId::new("prepared-call").unwrap(),
        name: ToolName::new("shared_tool").unwrap(),
        arguments: serde_json::json!({}),
    };

    tools
        .prepare(&prepared)
        .expect("prepare initial generation");
    let replacement = combine_tool_ports(vec![ToolPort::local(
        Arc::new(FakeTools::new(
            "shared_tool",
            ActionSource::BuiltInTool,
            "replacement",
        )),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    reloadable.replace(replacement);

    assert_eq!(
        tools
            .execute(
                &prepared,
                &ToolAuthorization::UnsandboxedGrant {
                    grant_id: GrantId::new("test")
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
            .unwrap(),
        ToolExecutionOutput::Success("initial".into())
    );
    let future = ToolCall {
        id: ash_protocol::ToolCallId::new("future-call").unwrap(),
        name: ToolName::new("shared_tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    tools
        .prepare(&future)
        .expect("prepare replacement generation");
    assert_eq!(
        tools
            .execute(
                &future,
                &ToolAuthorization::UnsandboxedGrant {
                    grant_id: GrantId::new("test")
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
            .unwrap(),
        ToolExecutionOutput::Success("replacement".into())
    );
}

#[test]
fn reload_after_durable_binding_but_before_prepare_keeps_original_generation() {
    let initial = combine_tool_ports(vec![ToolPort::local(
        Arc::new(FakeTools::new(
            "shared_tool",
            ActionSource::BuiltInTool,
            "initial",
        )),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    let reloadable = ReloadableToolPorts::new(initial);
    let tools = reloadable.tools();
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("bound-before-prepare").unwrap(),
        name: ToolName::new("shared_tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    let binding = tools
        .bind_call(&call, ash_protocol::ToolCallCaller::Direct)
        .unwrap()
        .unwrap();

    reloadable.replace(
        combine_tool_ports(vec![ToolPort::local(
            Arc::new(FakeTools::new(
                "shared_tool",
                ActionSource::BuiltInTool,
                "replacement",
            )),
            Arc::new(AskPolicy),
        )])
        .unwrap(),
    );

    tools
        .validate_call_binding(&call, Some(&binding))
        .expect("in-flight binding must retain the original generation");
    let review = tools.prepare(&call).unwrap();
    assert_eq!(review.provenance().source_id(), "initial");
    assert_eq!(
        tools
            .execute(
                &call,
                &ToolAuthorization::UnsandboxedGrant {
                    grant_id: GrantId::new("test"),
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
            .unwrap(),
        ToolExecutionOutput::Success("initial".into())
    );
}

#[test]
fn model_catalog_snapshot_binds_response_to_the_generation_visible_to_the_model() {
    let initial = combine_tool_ports(vec![ToolPort::local(
        Arc::new(FakeTools::new(
            "shared_tool",
            ActionSource::BuiltInTool,
            "initial",
        )),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    let reloadable = ReloadableToolPorts::new(initial);
    let tools = reloadable.tools();
    let catalog = tools
        .model_catalog_snapshot(&std::collections::BTreeSet::new())
        .expect("freeze model catalog");

    reloadable.replace(
        combine_tool_ports(vec![ToolPort::local(
            Arc::new(FakeTools::new(
                "shared_tool",
                ActionSource::BuiltInTool,
                "replacement",
            )),
            Arc::new(AskPolicy),
        )])
        .unwrap(),
    );

    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("model-safe-point").unwrap(),
        name: ToolName::new("shared_tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    let binding = catalog
        .bind_call(&call, ash_protocol::ToolCallCaller::Direct)
        .expect("reloadable catalog installs a frozen binder")
        .expect("bind against model-visible generation")
        .expect("model-visible tool remains callable");
    tools
        .validate_call_binding(&call, Some(&binding))
        .expect("frozen model binding remains live");
    let review = tools.prepare(&call).unwrap();
    assert_eq!(review.provenance().source_id(), "initial");
    assert_eq!(
        tools
            .execute(
                &call,
                &ToolAuthorization::UnsandboxedGrant {
                    grant_id: GrantId::new("test"),
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
            .unwrap(),
        ToolExecutionOutput::Success("initial".into())
    );
}

#[test]
fn durable_binding_from_another_process_incarnation_fails_closed() {
    let combined = combine_tool_ports(vec![ToolPort::local(
        Arc::new(FakeTools::new(
            "shared_tool",
            ActionSource::BuiltInTool,
            "initial",
        )),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    let first = ReloadableToolPorts::new(combined);
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("restart-call").unwrap(),
        name: ToolName::new("shared_tool").unwrap(),
        arguments: serde_json::json!({}),
    };
    let binding = first
        .tools()
        .bind_call(&call, ash_protocol::ToolCallCaller::Direct)
        .unwrap()
        .unwrap();

    let recovered = ReloadableToolPorts::new(
        combine_tool_ports(vec![ToolPort::local(
            Arc::new(FakeTools::new(
                "shared_tool",
                ActionSource::BuiltInTool,
                "initial",
            )),
            Arc::new(AskPolicy),
        )])
        .unwrap(),
    );
    let error = recovered
        .tools()
        .validate_call_binding(&call, Some(&binding))
        .unwrap_err();

    assert!(error.to_string().contains("registry incarnation"));
}

#[test]
fn sandbox_retry_keeps_the_prepared_generation_across_reload() {
    let definition = ToolDefinition {
        name: ToolName::new("sandboxed-tool").unwrap(),
        description: "sandboxed tool".into(),
        parameters: serde_json::json!({"type": "object"}),
        strict: false,
    };
    let initial = combine_tool_ports(vec![ToolPort::local(
        Arc::new(SandboxThenSuccessTools {
            definition: definition.clone(),
            result: "initial",
            calls: AtomicUsize::new(0),
        }),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    let reloadable = ReloadableToolPorts::new(initial);
    let tools = reloadable.tools();
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("sandbox-retry").unwrap(),
        name: definition.name,
        arguments: serde_json::json!({}),
    };
    tools.prepare(&call).unwrap();
    assert!(matches!(
        tools
            .execute(
                &call,
                &ToolAuthorization::Sandboxed(ash_sandboxing::SandboxPolicy::new(
                    ash_sandboxing::FileSystemAccess::ReadOnly,
                    ash_sandboxing::NetworkAccess::Denied,
                )),
                &ash_async_utils::CancellationSource::new().token(),
            )
            .unwrap(),
        ToolExecutionOutput::SandboxDenied(_)
    ));

    let replacement = combine_tool_ports(vec![ToolPort::local(
        Arc::new(SandboxThenSuccessTools {
            definition: ToolDefinition {
                name: ToolName::new("sandboxed-tool").unwrap(),
                description: "replacement".into(),
                parameters: serde_json::json!({"type": "object"}),
                strict: false,
            },
            result: "replacement",
            calls: AtomicUsize::new(1),
        }),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    reloadable.replace(replacement);

    assert_eq!(
        tools
            .execute(
                &call,
                &ToolAuthorization::UnsandboxedGrant {
                    grant_id: GrantId::new("retry"),
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
            .unwrap(),
        ToolExecutionOutput::Success("initial".into())
    );
}

#[test]
fn reloadable_and_composite_layers_preserve_durable_execution_facts() {
    let definition = ToolDefinition {
        name: ToolName::new("facts-aware").unwrap(),
        description: "facts aware".into(),
        parameters: serde_json::json!({"type": "object"}),
        strict: false,
    };
    let combined = combine_tool_ports(vec![ToolPort::local(
        Arc::new(FactsAwareTools { definition }),
        Arc::new(AskPolicy),
    )])
    .unwrap();
    let reloadable = ReloadableToolPorts::new(combined);
    let tools = reloadable.tools();
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("facts-call").unwrap(),
        name: ToolName::new("facts-aware").unwrap(),
        arguments: serde_json::json!({}),
    };
    tools.prepare(&call).unwrap();

    let output = tools
        .execute_streaming_with_facts(
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: GrantId::new("test"),
            },
            &ash_async_utils::CancellationSource::new().token(),
            &ToolExecutionFacts::default(),
            &mut TestSink,
        )
        .unwrap();

    assert_eq!(
        output,
        ToolExecutionOutput::Success("facts-preserved".into())
    );
}

#[test]
fn successful_replacement_clears_reconcile_diagnostic() {
    let reloadable = ReloadableToolPorts::new(None);
    reloadable.record_reconcile_failure("invalid MCP config");
    assert_eq!(
        reloadable.diagnostic().as_deref(),
        Some("invalid MCP config")
    );

    reloadable.replace(None);

    assert_eq!(reloadable.diagnostic(), None);
}
