use std::sync::Arc;

use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolService;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::CapabilitySet;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use core_api::CoreError;

use super::MCP_CALL_TOOL_NAME;
use super::MCP_DIRECT_TOKEN_LIMIT;
use super::MCP_SEARCH_TOOLS_NAME;
use super::decide_mcp_catalog_search;
use super::estimate_definition_tokens;
use crate::tool_composition::ToolPort;
use crate::tool_composition::combine_tool_ports;

struct CatalogTools {
    definitions: Vec<ToolDefinition>,
    connection_generation: u64,
}

impl CatalogTools {
    fn with_count(count: usize) -> Self {
        Self {
            definitions: (0..count)
                .map(|index| {
                    definition(
                        format!("server__tool_{index}"),
                        &format!("test tool capability number {index}"),
                    )
                })
                .collect(),
            connection_generation: 1,
        }
    }
}

impl ToolService for CatalogTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn source_provenance(&self, name: &ToolName) -> Vec<ash_protocol::ToolSourceProvenance> {
        vec![ash_protocol::ToolSourceProvenance::Mcp {
            server_id: "server".into(),
            remote_name: name.to_string(),
            catalog_generation: 1,
            connection_generation: self.connection_generation,
        }]
    }

    fn read_resource(
        &self,
        call: &ToolCall,
        uri: &str,
        _: &CancellationToken,
    ) -> Result<ash_protocol::ToolOutputArtifact, CoreError> {
        Ok(ash_protocol::ToolOutputArtifact::new(
            ash_protocol::ToolOutputArtifactSource::EmbeddedResource { uri: uri.into() },
            "text/plain".into(),
            ash_protocol::ToolOutputArtifactData::Text {
                text: format!("{}:{}", call.name, call.arguments),
            },
        ))
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(call.name.as_str()),
                ActionKind::SystemOperation,
                call.name.to_string(),
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::McpServer, "test-server"),
            SandboxCompatibility::NotApplicable {
                reason: "test".into(),
            },
            ActionPolicyRevision::new("test-mcp-v1"),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Ok(ToolExecutionOutput::Success(format!(
            "{}:{}",
            call.name, call.arguments
        )))
    }
}

struct CatalogPolicy;

impl core_api::ActionPolicyService for CatalogPolicy {
    fn revision(&self) -> String {
        "test-policy".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ash_action_policy::ExecutionDecision, CoreError> {
        Ok(ash_action_policy::ExecutionDecision::RunUnsandboxed {
            grant_id: ash_action_policy::GrantId::new("test"),
        })
    }
}

fn compose_mcp(tools: Arc<dyn ToolService>) -> crate::tool_composition::CombinedToolPorts {
    combine_tool_ports(vec![ToolPort::mcp(tools, Arc::new(CatalogPolicy)).unwrap()])
        .unwrap()
        .unwrap()
}

fn model_definitions(service: &dyn ToolService) -> Vec<ToolDefinition> {
    service.model_definitions(&Default::default()).unwrap()
}

#[test]
fn tool_count_threshold_switches_the_entire_mcp_catalog() {
    let direct = compose_mcp(Arc::new(CatalogTools::with_count(15))).tools;
    assert_eq!(model_definitions(direct.as_ref()).len(), 15);
    assert!(
        model_definitions(direct.as_ref())
            .iter()
            .all(|definition| definition.name.as_str().starts_with("server__"))
    );

    let meta = compose_mcp(Arc::new(CatalogTools::with_count(16))).tools;
    assert_eq!(
        model_definitions(meta.as_ref())
            .into_iter()
            .map(|definition| definition.name.to_string())
            .collect::<Vec<_>>(),
        vec![MCP_CALL_TOOL_NAME, MCP_SEARCH_TOOLS_NAME, "tool_search"]
    );
}

#[test]
fn catalog_changes_keep_meta_definitions_stable_and_reject_previous_bindings() {
    let original = compose_mcp(Arc::new(CatalogTools::with_count(16))).tools;
    let updated = compose_mcp(Arc::new(CatalogTools {
        connection_generation: 2,
        ..CatalogTools::with_count(16)
    }))
    .tools;
    assert_eq!(
        model_definitions(original.as_ref()),
        model_definitions(updated.as_ref())
    );

    let search = ToolCall {
        id: ash_protocol::ToolCallId::new("search-original").unwrap(),
        name: ToolName::new(MCP_SEARCH_TOOLS_NAME).unwrap(),
        arguments: serde_json::json!({"query": "tool 7"}),
    };
    let review = original.prepare(&search).unwrap();
    let cancellation = ash_async_utils::CancellationSource::new();
    let ash_action_policy::ExecutionDecision::RunUnsandboxed { grant_id } =
        decide_mcp_catalog_search(&review, &cancellation.token()).unwrap()
    else {
        panic!("catalog search must receive its read-only grant");
    };
    let ToolExecutionOutput::Success(result) = original
        .execute(
            &search,
            &ToolAuthorization::UnsandboxedGrant { grant_id },
            &cancellation.token(),
        )
        .unwrap()
    else {
        panic!("catalog search must succeed");
    };
    let result: serde_json::Value = serde_json::from_str(&result).unwrap();
    let binding = &result["tools"][0];
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("call-original-binding").unwrap(),
        name: ToolName::new(MCP_CALL_TOOL_NAME).unwrap(),
        arguments: serde_json::json!({
            "tool": binding["name"],
            "catalog_digest": binding["catalog_digest"],
            "definition_digest": binding["definition_digest"],
            "arguments": {"value": 7}
        }),
    };
    original.prepare(&call).unwrap();
    let resource = original
        .read_resource(&call, "docs://result", &cancellation.token())
        .unwrap();
    assert!(
        matches!(resource.data, ash_protocol::ToolOutputArtifactData::Text { text } if text.contains("server__tool_7") && text.contains("\"value\":7"))
    );
    assert!(
        updated
            .read_resource(&call, "docs://result", &cancellation.token())
            .is_err()
    );
    assert!(
        original
            .read_resource(&search, "docs://result", &cancellation.token())
            .is_err()
    );
    assert!(updated.prepare(&call).is_err());
    assert!(
        updated
            .execute(
                &call,
                &ToolAuthorization::UnsandboxedGrant {
                    grant_id: ash_action_policy::GrantId::new("test")
                },
                &cancellation.token(),
            )
            .is_err()
    );
}

#[test]
fn token_threshold_is_inclusive_and_uses_the_stable_v1_estimate() {
    let at_limit = definition_with_token_estimate(MCP_DIRECT_TOKEN_LIMIT);
    assert_eq!(estimate_definition_tokens(&[at_limit.clone()]), 5_000);
    let direct = compose_mcp(Arc::new(CatalogTools {
        definitions: vec![at_limit],
        connection_generation: 1,
    }))
    .tools;
    assert_eq!(
        model_definitions(direct.as_ref())[0].name.as_str(),
        "server__large"
    );

    let over_limit = definition_with_token_estimate(MCP_DIRECT_TOKEN_LIMIT + 1);
    let meta = compose_mcp(Arc::new(CatalogTools {
        definitions: vec![over_limit],
        connection_generation: 1,
    }))
    .tools;
    assert_eq!(model_definitions(meta.as_ref()).len(), 3);
}

#[test]
fn large_mcp_catalog_loads_one_bound_definition_through_shared_discovery() {
    let combined = compose_mcp(Arc::new(CatalogTools::with_count(512)));
    let before = model_definitions(combined.tools.as_ref());
    assert_eq!(before.len(), 3);
    let target = ToolName::new("server__tool_417").unwrap();
    let scoped = combined
        .tools
        .resolve_tool_scope(&ash_protocol::ToolScope {
            tools: vec![target.clone()],
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        scoped.iter().map(ToolName::as_str).collect::<Vec<_>>(),
        [
            "call_mcp_tool",
            "search_tools",
            "server__tool_417",
            "tool_search"
        ]
    );
    let cancellation = ash_async_utils::CancellationSource::new();
    let mut results = Vec::new();
    for (name, arguments) in [
        (MCP_SEARCH_TOOLS_NAME, serde_json::json!({"query":target})),
        (
            "tool_search",
            serde_json::json!({"query":target,"strategy":"bm25","limit":1}),
        ),
    ] {
        let call = ToolCall {
            id: ash_protocol::ToolCallId::new(name).unwrap(),
            name: ToolName::new(name).unwrap(),
            arguments,
        };
        let request = combined.tools.prepare(&call).unwrap();
        let ash_action_policy::ExecutionDecision::RunUnsandboxed { grant_id } = combined
            .policy
            .decide(&request, &cancellation.token())
            .unwrap()
        else {
            panic!("discovery requires its host grant");
        };
        let ToolExecutionOutput::Success(output) = combined
            .tools
            .execute(
                &call,
                &ToolAuthorization::UnsandboxedGrant { grant_id },
                &cancellation.token(),
            )
            .unwrap()
        else {
            panic!("discovery did not find the exact tool");
        };
        let payload: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(payload["tools"][0]["name"], target.as_str());
        results.push(combined.tools.activated_tool_names(&call, &output).unwrap());
    }
    assert!(results[0].is_empty());
    assert_eq!(results[1], vec![target.clone()]);
    let after = combined
        .tools
        .model_definitions(&results.remove(1).into_iter().collect())
        .unwrap();
    assert_eq!(after.len(), before.len() + 1);
    assert!(after.iter().any(|definition| definition.name == target));
}

#[test]
fn meta_call_requires_the_exact_search_result_binding() {
    let meta = compose_mcp(Arc::new(CatalogTools::with_count(16))).tools;
    let search = ToolCall {
        id: ash_protocol::ToolCallId::new("search").unwrap(),
        name: ToolName::new(MCP_SEARCH_TOOLS_NAME).unwrap(),
        arguments: serde_json::json!({"query": "tool 7"}),
    };
    let review = meta.prepare(&search).unwrap();
    let ash_action_policy::ExecutionDecision::RunUnsandboxed { grant_id } =
        decide_mcp_catalog_search(&review, &ash_async_utils::CancellationSource::new().token())
            .unwrap()
    else {
        panic!("search must receive an internal read-only grant");
    };
    let ToolExecutionOutput::Success(output) = meta
        .execute(
            &search,
            &ToolAuthorization::UnsandboxedGrant { grant_id },
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("search must succeed");
    };
    let output: serde_json::Value = serde_json::from_str(&output).unwrap();
    let matched = &output["tools"][0];
    let call = ToolCall {
        id: ash_protocol::ToolCallId::new("call").unwrap(),
        name: ToolName::new(MCP_CALL_TOOL_NAME).unwrap(),
        arguments: serde_json::json!({
            "tool": matched["name"],
            "catalog_digest": matched["catalog_digest"],
            "definition_digest": matched["definition_digest"],
            "arguments": {"value": 7}
        }),
    };
    assert_eq!(
        meta.prepare(&call).unwrap().provenance().source(),
        &ActionSource::McpServer
    );
    assert!(matches!(
        meta.execute(
            &call,
            &ToolAuthorization::UnsandboxedGrant {
                grant_id: ash_action_policy::GrantId::new("test")
            },
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap(),
        ToolExecutionOutput::Success(result) if result.contains("server__tool_7")
    ));

    let mut forged = call;
    forged.arguments["definition_digest"] = serde_json::json!("sha256:forged");
    assert!(
        meta.prepare(&forged)
            .unwrap_err()
            .to_string()
            .contains("use search_tools first")
    );
}

fn definition(name: String, description: &str) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).unwrap(),
        description: description.into(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        strict: false,
    }
}

fn definition_with_token_estimate(target: usize) -> ToolDefinition {
    let mut candidate = definition("server__large".into(), "test capability");
    candidate.parameters = serde_json::json!({
        "type": "object",
        "properties": {"value": {"type": "string", "description": ""}},
    });
    let overhead = serde_json::to_vec(std::slice::from_ref(&candidate))
        .unwrap()
        .len();
    candidate.parameters["properties"]["value"]["description"] =
        serde_json::json!("x".repeat(target * 4 - overhead));
    candidate
}

#[test]
fn frozen_selection_filters_mcp_search_and_blocks_nested_calls_in_the_turn_executor() {
    for positive in [false, true] {
        use ash_core::CreateThreadRequest;
        use ash_core::InMemoryThreadStore;
        use ash_core::StartTurnRequest;
        use ash_core::ThreadController;
        use ash_core::TurnExecutor;
        use ash_protocol::ModelRequest;
        use ash_protocol::ModelResponse;
        use ash_protocol::ResponseItem;
        use ash_protocol::StopReason;
        use core_api::ModelService;
        use core_api::SequenceExpectation;
        use std::collections::VecDeque;
        use std::sync::Mutex;

        struct CatalogModel(Mutex<VecDeque<ModelResponse>>);
        impl ModelService for CatalogModel {
            fn invoke(
                &self,
                _: core_api::ModelSelection<'_>,
                _: &ModelRequest,
                _: &CancellationToken,
            ) -> Result<ModelResponse, CoreError> {
                self.0
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or_else(|| CoreError::Execution("unexpected model call".into()))
            }
        }
        struct CountedTools {
            inner: CatalogTools,
            calls: std::sync::atomic::AtomicUsize,
        }
        impl ToolService for CountedTools {
            fn definitions(&self) -> Vec<ToolDefinition> {
                self.inner.definitions()
            }
            fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
                self.inner.prepare(call)
            }
            fn execute(
                &self,
                call: &ToolCall,
                authorization: &ToolAuthorization,
                cancellation: &CancellationToken,
            ) -> Result<ToolExecutionOutput, CoreError> {
                self.calls
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.inner.execute(call, authorization, cancellation)
            }
        }
        let actual = Arc::new(CountedTools {
            inner: CatalogTools::with_count(16),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let service = super::McpMetaToolService::new(actual.clone(), &actual.definitions());
        let combined = compose_mcp(actual.clone());
        let disabled = ToolName::new("server__tool_7").unwrap();
        let definition_digest = service.definition_digests.get(&disabled).unwrap();
        let calls = [
            ToolCall {
                id: ash_protocol::ToolCallId::new("selected-search").unwrap(),
                name: ToolName::new(MCP_SEARCH_TOOLS_NAME).unwrap(),
                arguments: serde_json::json!({"query":"tool 7"}),
            },
            ToolCall {
                id: ash_protocol::ToolCallId::new("disabled-nested-call").unwrap(),
                name: ToolName::new(MCP_CALL_TOOL_NAME).unwrap(),
                arguments: serde_json::json!({"tool":disabled, "catalog_digest":service.catalog_digest, "definition_digest":definition_digest, "arguments":{}}),
            },
        ];
        let model = Arc::new(CatalogModel(Mutex::new(
            calls
                .into_iter()
                .map(|call| ModelResponse {
                    output: vec![ResponseItem::ToolCall(call)],
                    usage: None,
                    billing: None,
                    stop_reason: StopReason::ToolUse,
                })
                .collect(),
        )));
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let thread_id = ash_protocol::ThreadId::new("selected-mcp").unwrap();
        threads
            .create_thread(CreateThreadRequest {
                execution_target: None,
                agent_id: ash_protocol::AgentId::new("agent").unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new("session").unwrap(),
                thread_id: thread_id.clone(),
                title: "selection".into(),
            })
            .unwrap();
        let executor = TurnExecutor::new(threads.clone(), model, combined.tools, combined.policy);
        let turn = threads
            .start_turn(
                &thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: ash_protocol::CommandId::new("start-selected-mcp").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: executor.policy_revision(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: Some(executor.tool_profile_snapshot().unwrap()),
                    activated_skills: Vec::new(),
                    input: vec![
                        ash_protocol::UserInput::Text {
                            text: "search then try a disabled tool".into(),
                        },
                        ash_protocol::UserInput::ToolSelection {
                            allowed: positive.then(|| {
                                [MCP_SEARCH_TOOLS_NAME, MCP_CALL_TOOL_NAME, "server__tool_0"]
                                    .into_iter()
                                    .map(|name| ToolName::new(name).unwrap())
                                    .collect()
                            }),
                            disabled: if positive {
                                Vec::new()
                            } else {
                                vec![disabled.clone()]
                            },
                        },
                    ],
                },
            )
            .unwrap();
        executor.start(&thread_id, &turn.turn_id).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let cancellation = ash_async_utils::CancellationSource::new();
        let snapshot = loop {
            let changed = threads.thread_changed(&thread_id).unwrap();
            let snapshot = threads.read_thread(&thread_id).unwrap();
            if snapshot.turns[0].status == ash_protocol::TurnStatus::Failed {
                break snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "disabled nested call did not fail: {:?}",
                snapshot.items
            );
            pollster::block_on(ash_async_utils::wait_until(
                changed,
                deadline,
                &cancellation.token(),
            ))
            .unwrap();
        };
        assert_eq!(actual.calls.load(std::sync::atomic::Ordering::Relaxed), 0);
        let search = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                ash_protocol::ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: false,
                    ..
                } if tool_call_id.as_str() == "selected-search" => Some(text),
                _ => None,
            })
            .unwrap_or_else(|| {
                panic!(
                    "search did not succeed under selection {positive}: {:?}",
                    snapshot.items
                )
            });
        let result: serde_json::Value = serde_json::from_str(search).unwrap();
        assert!(
            result["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["name"] != disabled.as_str())
        );
        assert!(snapshot.items.iter().all(
        |item| !matches!(item, ash_protocol::ThreadItem::ToolCall { name, .. } if name == &disabled)
    ));
    }
}
