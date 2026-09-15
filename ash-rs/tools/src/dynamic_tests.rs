use super::from_dynamic_tool_spec;
use crate::{ToolInvocationKind, ToolLoading, ToolName};
use ash_protocol::DynamicToolSpec;
use serde_json::json;

#[test]
fn dynamic_tool_uses_the_shared_function_definition() {
    let definition = from_dynamic_tool_spec(&DynamicToolSpec {
        name: ToolName::new("request_location").expect("valid tool name"),
        description: "Ask the client for a location.".to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {"prompt": {"type": "string"}},
            "required": ["prompt"]
        }),
    })
    .expect("dynamic definition is valid");

    assert_eq!(definition.name().as_str(), "request_location");
    assert_eq!(definition.loading(), ToolLoading::Eager);
    assert!(matches!(
        definition.invocation(),
        ToolInvocationKind::Function { .. }
    ));
}
