use crate::{
    DynamicToolAdapterError, ToolDefinition, ToolInputSchema, ToolLoading, ToolOutputSchema,
    ToolSchemaMode,
};
use ash_protocol::DynamicToolSpec;

/// Converts a client-provided dynamic tool into the same validated definition used by host tools.
///
/// Dynamic tools are eagerly exposed for their current interaction scope. Their execution and
/// owner lifecycle remain owned by Core and the App Server interaction layer.
pub fn from_dynamic_tool_spec(
    specification: &DynamicToolSpec,
) -> Result<ToolDefinition, DynamicToolAdapterError> {
    let input_schema = ToolInputSchema::parse(specification.input_schema.clone())
        .map_err(DynamicToolAdapterError::Schema)?;
    ToolDefinition::function(
        specification.name.clone(),
        specification.description.clone(),
        input_schema,
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .map_err(DynamicToolAdapterError::Definition)
}

#[cfg(test)]
#[path = "dynamic_tests.rs"]
mod tests;
