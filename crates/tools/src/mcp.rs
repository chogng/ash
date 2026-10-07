use crate::{
    McpToolAdapterError, ToolDefinition, ToolInputSchema, ToolLoading, ToolOutputSchema,
    ToolSchema, ToolSchemaMode,
};
use ash_protocol::ToolName;
use serde_json::{Map, Value};

/// A wire-neutral projection of one MCP tool descriptor.
///
/// `ash-mcp` owns construction from a negotiated MCP revision and retains the exact remote
/// identity separately. This value contains only the data shared with the host tool adapter.
#[derive(Clone, Debug, PartialEq)]
pub struct McpToolProjection {
    pub remote_name: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: McpOutputSchemaProjection,
}

/// The optional structured-content schema declared by an MCP tool.
#[derive(Clone, Debug, PartialEq)]
pub enum McpOutputSchemaProjection {
    Unspecified,
    Schema(Value),
}

/// Converts a validated MCP descriptor projection into a host function definition.
///
/// MCP servers may omit object `properties`; the adapter makes that compatibility case explicit
/// before applying the common input-schema validator. Exposure remains a host policy decision.
pub fn from_mcp_tool_projection(
    exposed_name: ToolName,
    projection: &McpToolProjection,
    loading: ToolLoading,
) -> Result<ToolDefinition, McpToolAdapterError> {
    if projection.remote_name.trim().is_empty() {
        return Err(McpToolAdapterError::EmptyRemoteName);
    }
    let input_schema =
        ToolInputSchema::parse(normalize_mcp_input_schema(projection.input_schema.clone()))
            .map_err(McpToolAdapterError::Schema)?;
    let output_schema = match &projection.output_schema {
        McpOutputSchemaProjection::Unspecified => ToolOutputSchema::Unspecified,
        McpOutputSchemaProjection::Schema(schema) => ToolOutputSchema::Schema(
            ToolSchema::parse(schema.clone()).map_err(McpToolAdapterError::Schema)?,
        ),
    };
    ToolDefinition::function(
        exposed_name,
        projection.description.clone(),
        input_schema,
        output_schema,
        ToolSchemaMode::ProviderDefault,
        loading,
    )
    .map_err(McpToolAdapterError::Definition)
}

fn normalize_mcp_input_schema(mut value: Value) -> Value {
    let Value::Object(object) = &mut value else {
        return value;
    };
    if object
        .get("properties")
        .is_none_or(|properties| properties.is_null())
    {
        object.insert("properties".to_owned(), Value::Object(Map::new()));
    }
    value
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
