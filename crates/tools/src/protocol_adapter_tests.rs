use super::{from_protocol_tool_definition, to_protocol_tool_definition, to_protocol_tool_result};
use crate::{
    FreeformFormat, ImageDetail, ToolContent, ToolDefinition, ToolInputSchema, ToolLoading,
    ToolName, ToolOutput, ToolOutputSchema, ToolSchemaMode,
};
use ash_protocol::ToolCallId;
use serde_json::json;

#[test]
fn protocol_adapter_preserves_strict_function_metadata() {
    let definition = ToolDefinition::function(
        ToolName::new("search").expect("valid tool name"),
        "Search indexed documents.",
        ToolInputSchema::parse(json!({"type": "object", "properties": {}}))
            .expect("valid input schema"),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        ToolLoading::Eager,
    )
    .expect("valid definition");

    let protocol = to_protocol_tool_definition(&definition).expect("function is supported");

    assert_eq!(protocol.name.as_str(), "search");
    assert!(protocol.strict);
}

#[test]
fn protocol_definition_adapter_keeps_host_loading_explicit() {
    let protocol = ash_protocol::ToolDefinition {
        name: ToolName::new("search").unwrap(),
        description: "Search indexed documents.".into(),
        parameters: json!({"type": "object", "properties": {}}),
        strict: true,
    };

    let host = from_protocol_tool_definition(&protocol, ToolLoading::Deferred).unwrap();

    assert_eq!(host.loading(), ToolLoading::Deferred);
    assert_eq!(host.schema_mode(), ToolSchemaMode::Strict);
}

#[test]
fn protocol_adapter_rejects_freeform_definitions() {
    let definition = ToolDefinition::freeform(
        ToolName::new("exec").expect("valid tool name"),
        "Run freeform source.",
        FreeformFormat::new("lark", "start: /[\\s\\S]+/").expect("valid format"),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::ProviderDefault,
        ToolLoading::Eager,
    )
    .expect("valid definition");

    assert!(to_protocol_tool_definition(&definition).is_err());
}

#[test]
fn protocol_adapter_preserves_error_and_image_content() {
    let result = to_protocol_tool_result(
        &ToolOutput::error(vec![
            ToolContent::Text("not found".to_owned()),
            ToolContent::Image {
                url: "data:image/png;base64,AA==".to_owned(),
                detail: ImageDetail::Low,
            },
        ]),
        ToolCallId::new("call_1").expect("valid call ID"),
        ToolName::new("lookup").expect("valid tool name"),
    );

    assert!(result.is_error);
    assert_eq!(result.content.len(), 2);
}
