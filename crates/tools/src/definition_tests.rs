use super::{
    FreeformFormat, ToolDefinition, ToolInvocationKind, ToolLoading, ToolOutputSchema,
    ToolSchemaMode,
};
use crate::ToolInputSchema;
use crate::ToolName;
use serde_json::json;

#[test]
fn function_definition_preserves_its_explicit_loading_and_schema_mode() {
    let input = ToolInputSchema::parse(json!({"type": "object", "properties": {}}))
        .expect("valid input schema");
    let definition = ToolDefinition::function(
        ToolName::new("search").expect("valid tool name"),
        "Search indexed documents.",
        input,
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        ToolLoading::Deferred,
    )
    .expect("valid definition");

    assert_eq!(definition.schema_mode(), ToolSchemaMode::Strict);
    assert_eq!(definition.loading(), ToolLoading::Deferred);
    assert!(matches!(
        definition.invocation(),
        ToolInvocationKind::Function { .. }
    ));
}

#[test]
fn freeform_format_requires_explicit_syntax_and_definition() {
    assert!(FreeformFormat::new("", "grammar").is_err());
    assert!(FreeformFormat::new("lark", "").is_err());
}
