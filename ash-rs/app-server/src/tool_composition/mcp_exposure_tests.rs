use std::sync::Arc;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolService;
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
