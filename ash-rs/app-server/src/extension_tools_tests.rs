use std::sync::Arc;

use super::compose_extension_tools;
use crate::tool_composition::combine_tool_ports;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationSource;
use ash_extension_api::CapabilityToolContribution;
use ash_extension_api::CapabilityToolContributor;
use ash_extension_api::ExtensionError;
use ash_extension_api::ExtensionRegistryBuilder;
use ash_extension_api::ExtensionToolAuthority;
use ash_extension_api::ReadOnlyToolContributor;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_tools::ToolConcurrency;
use ash_tools::ToolDefinition;
use ash_tools::ToolExecutionFuture;
use ash_tools::ToolExecutionOutcome;
use ash_tools::ToolExecutor;
use ash_tools::ToolInputSchema;
use ash_tools::ToolLoading;
use ash_tools::ToolName;
use ash_tools::ToolOutput;
use ash_tools::ToolOutputSchema;
use ash_tools::ToolSchemaMode;
use serde_json::json;

struct Contributor;

impl ReadOnlyToolContributor for Contributor {
    fn contribute(&self) -> Result<Vec<Arc<dyn ToolExecutor>>, ExtensionError> {
        Ok(vec![Arc::new(ReadOnlyExtensionTool {
            definition: ToolDefinition::function(
                ToolName::new("extension-read").unwrap(),
                "Read extension-owned metadata.",
                ToolInputSchema::parse(json!({
                    "type": "object",
                    "properties": {"key": {"type": "string"}},
                    "required": ["key"]
                }))
                .unwrap(),
                ToolOutputSchema::Unspecified,
                ToolSchemaMode::Strict,
                ToolLoading::Eager,
            )
            .unwrap(),
        })])
    }
}

struct ReadOnlyExtensionTool {
    definition: ToolDefinition,
}

impl ToolExecutor for ReadOnlyExtensionTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::ParallelSafe
    }

    fn execute(&self, _: ash_tools::ToolInvocation) -> ToolExecutionFuture<'_> {
        Box::pin(std::future::ready(ToolExecutionOutcome::Returned(
            ToolOutput::success(Vec::new()),
        )))
    }
}

#[test]
fn read_only_extension_contributors_enter_the_shared_registry_and_policy() {
    let mut builder = ExtensionRegistryBuilder::new();
    builder.read_only_tool_contributor("test", Arc::new(Contributor));
    let registry = builder.build();
    let port = compose_extension_tools(&registry).unwrap().unwrap();
    let combined = combine_tool_ports(vec![port]).unwrap().unwrap();
    assert_eq!(
        combined
            .tools
            .model_definitions(&Default::default())
            .unwrap()
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["extension-read"]
    );
    let call = ToolCall {
        id: ToolCallId::new("call-1").unwrap(),
        name: ash_protocol::ToolName::new("extension-read").unwrap(),
        arguments: json!({"key": "value"}),
    };
    let review = combined.tools.prepare(&call).unwrap();
    assert!(matches!(
        combined
            .policy
            .decide(&review, &CancellationSource::new().token()),
        Ok(ExecutionDecision::RunUnsandboxed { .. })
    ));
}

struct NetworkContributor;

impl CapabilityToolContributor for NetworkContributor {
    fn contribute(&self) -> Result<Vec<CapabilityToolContribution>, ExtensionError> {
        Ok(vec![CapabilityToolContribution::new(
            Arc::new(ReadOnlyExtensionTool {
                definition: ToolDefinition::function(
                    ToolName::new("web_search").unwrap(),
                    "Search an external index.",
                    ToolInputSchema::parse(json!({
                        "type": "object",
                        "properties": {"q": {"type": "string"}},
                        "required": ["q"]
                    }))
                    .unwrap(),
                    ToolOutputSchema::Unspecified,
                    ToolSchemaMode::Strict,
                    ToolLoading::Eager,
                )
                .unwrap(),
            }),
            ExtensionToolAuthority::ExternalRead {
                service: "test search".into(),
                network_scopes: vec!["search.example.com".into()],
                credential_reference: Some("secret:test-search".into()),
            },
        )])
    }
}

#[test]
fn capability_extension_tools_freeze_scopes_and_require_user_approval() {
    let mut builder = ExtensionRegistryBuilder::new();
    builder.capability_tool_contributor("network", Arc::new(NetworkContributor));
    let port = compose_extension_tools(&builder.build()).unwrap().unwrap();
    let combined = combine_tool_ports(vec![port]).unwrap().unwrap();
    let call = ToolCall {
        id: ToolCallId::new("call-network").unwrap(),
        name: ash_protocol::ToolName::new("web_search").unwrap(),
        arguments: json!({"q": "ash"}),
    };

    let review = combined.tools.prepare(&call).unwrap();

    assert_eq!(
        review.action().kind(),
        &ash_action_policy::ActionKind::NetworkRequest
    );
    assert_eq!(review.action().required_capabilities().iter().count(), 2);
    assert!(matches!(
        combined
            .policy
            .decide(&review, &CancellationSource::new().token()),
        Ok(ExecutionDecision::AskUser(_))
    ));
}
