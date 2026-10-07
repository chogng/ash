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
use super::project_mcp_service;

struct CatalogTools {
    definitions: Vec<ToolDefinition>,
}

impl CatalogTools {
    fn with_count(count: usize) -> Self {
        Self {
            definitions: (0..count)
                .map(|index| definition(format!("server__tool_{index}"), "test capability"))
                .collect(),
        }
    }
}

impl ToolService for CatalogTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
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

#[test]
fn tool_count_threshold_switches_the_entire_mcp_catalog() {
    let direct = project_mcp_service(Arc::new(CatalogTools::with_count(15)));
    assert_eq!(direct.definitions().len(), 15);
    assert!(
        direct
            .definitions()
            .iter()
            .all(|definition| definition.name.as_str().starts_with("server__"))
    );

    let meta = project_mcp_service(Arc::new(CatalogTools::with_count(16)));
    assert_eq!(
        meta.definitions()
            .into_iter()
            .map(|definition| definition.name.to_string())
            .collect::<Vec<_>>(),
        vec![MCP_SEARCH_TOOLS_NAME, MCP_CALL_TOOL_NAME]
    );
}

#[test]
fn catalog_changes_keep_meta_definitions_stable_and_reject_previous_bindings() {
    let original = project_mcp_service(Arc::new(CatalogTools::with_count(16)));
    let updated = project_mcp_service(Arc::new(CatalogTools::with_count(17)));
    assert_eq!(original.definitions(), updated.definitions());

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
    let direct = project_mcp_service(Arc::new(CatalogTools {
        definitions: vec![at_limit],
    }));
    assert_eq!(direct.definitions()[0].name.as_str(), "server__large");

    let over_limit = definition_with_token_estimate(MCP_DIRECT_TOKEN_LIMIT + 1);
    let meta = project_mcp_service(Arc::new(CatalogTools {
        definitions: vec![over_limit],
    }));
    assert_eq!(meta.definitions().len(), 2);
    assert_eq!(meta.definitions()[0].name.as_str(), MCP_SEARCH_TOOLS_NAME);
}

#[test]
fn meta_call_requires_the_exact_search_result_binding() {
    let meta = project_mcp_service(Arc::new(CatalogTools::with_count(16)));
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
    for size in 1..=target * 4 {
        let candidate = definition("server__large".into(), &"x".repeat(size));
        if estimate_definition_tokens(std::slice::from_ref(&candidate)) == target {
            return candidate;
        }
    }
    panic!("could not construct definition with {target} estimated tokens");
}

#[test]
fn frozen_selection_filters_mcp_search_and_blocks_nested_calls_in_the_turn_executor() {
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
    struct CatalogPolicy;
    impl core_api::ActionPolicyService for CatalogPolicy {
        fn revision(&self) -> String {
            "test-policy".into()
        }
        fn decide(
            &self,
            request: &ActionReviewRequest,
            cancellation: &CancellationToken,
        ) -> Result<ash_action_policy::ExecutionDecision, CoreError> {
            if request.provenance().source_id() == MCP_SEARCH_TOOLS_NAME {
                decide_mcp_catalog_search(request, cancellation)
            } else {
                Ok(ash_action_policy::ExecutionDecision::RunUnsandboxed {
                    grant_id: ash_action_policy::GrantId::new("test"),
                })
            }
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
    let service = Arc::new(super::McpMetaToolService::new(
        actual.clone(),
        actual.definitions(),
    ));
    let disabled = ToolName::new("server__tool_7").unwrap();
    let entry = service.by_name.get(&disabled).unwrap();
    let calls = [
        ToolCall {
            id: ash_protocol::ToolCallId::new("selected-search").unwrap(),
            name: ToolName::new(MCP_SEARCH_TOOLS_NAME).unwrap(),
            arguments: serde_json::json!({"query":"tool 7"}),
        },
        ToolCall {
            id: ash_protocol::ToolCallId::new("disabled-nested-call").unwrap(),
            name: ToolName::new(MCP_CALL_TOOL_NAME).unwrap(),
            arguments: serde_json::json!({"tool":disabled, "catalog_digest":service.catalog_digest, "definition_digest":entry.definition_digest, "arguments":{}}),
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
    let executor = TurnExecutor::new(threads.clone(), model, service, Arc::new(CatalogPolicy));
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
                policy_revision: "test-policy".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: Some(executor.tool_profile_snapshot().unwrap()),
                activated_skills: Vec::new(),
                input: vec![
                    ash_protocol::UserInput::Text {
                        text: "search then try a disabled tool".into(),
                    },
                    ash_protocol::UserInput::ToolSelection {
                        disabled: vec![disabled.clone()],
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
        .unwrap();
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
