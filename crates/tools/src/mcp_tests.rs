use super::{McpOutputSchemaProjection, McpToolProjection, from_mcp_tool_projection};
use crate::{ToolInvocationKind, ToolLoading, ToolName, ToolOutputSchema};
use serde_json::json;

#[test]
fn mcp_adapter_adds_missing_properties_before_common_validation() {
    let definition = from_mcp_tool_projection(
        ToolName::new("docs_search").expect("valid tool name"),
        &McpToolProjection {
            remote_name: "docs.search".to_owned(),
            description: "Search documentation.".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: McpOutputSchemaProjection::Unspecified,
        },
        ToolLoading::Deferred,
    )
    .expect("MCP schema without properties remains compatible");

    let ToolInvocationKind::Function { input_schema } = definition.invocation() else {
        panic!("MCP tool must become a function");
    };
    assert_eq!(input_schema.as_value()["properties"], json!({}));
    assert_eq!(definition.loading(), ToolLoading::Deferred);
}

#[test]
fn mcp_adapter_preserves_structured_content_schema() {
    let definition = from_mcp_tool_projection(
        ToolName::new("lookup").expect("valid tool name"),
        &McpToolProjection {
            remote_name: "lookup".to_owned(),
            description: "Look up a value.".to_owned(),
            input_schema: json!({"type": "object", "properties": {}}),
            output_schema: McpOutputSchemaProjection::Schema(json!({"type": "object"})),
        },
        ToolLoading::Eager,
    )
    .expect("MCP schema is valid");

    assert!(matches!(
        definition.output_schema(),
        ToolOutputSchema::Schema(_)
    ));
}
