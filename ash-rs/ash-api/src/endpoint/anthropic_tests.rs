use super::*;
use crate::ImageDetail;
use crate::ReasoningConfig;

#[test]
fn reasoning_uses_anthropic_effort_for_messages_and_token_counts() {
    let mut request = ModelRequest::text("Explain the result");
    request.reasoning = Some(ReasoningConfig {
        effort: ReasoningEffort::ExtraHigh,
        summary: false,
    });

    let message = build_request("claude-opus-4-8", &request).unwrap();
    assert_eq!(message["output_config"], json!({"effort": "xhigh"}));
    assert!(message.get("thinking").is_none());

    let count = build_count_request("claude-opus-4-8", &request).unwrap();
    assert_eq!(count["output_config"], message["output_config"]);

    request.reasoning.as_mut().unwrap().effort = ReasoningEffort::None;
    assert!(matches!(
        build_request("claude-opus-4-8", &request),
        Err(ApiError::InvalidRequest(_))
    ));
}

#[test]
fn request_builder_injects_three_stable_cache_breakpoints_without_mutating_canonical_input() {
    let mut request = ModelRequest::text("latest request");
    request.instructions = Some("stable system instructions".into());
    request.input.insert(
        0,
        InputItem::Message(Message::text(MessageRole::User, "earlier request")),
    );
    request.input.insert(
        1,
        InputItem::Message(Message::text(MessageRole::Assistant, "earlier answer")),
    );
    request.prompt_cache_prefix_end = Some(2);
    request.tools = vec![
        ToolDefinition {
            name: ToolName::new("first").unwrap(),
            description: "First tool".into(),
            parameters: json!({"type": "object"}),
            strict: true,
        },
        ToolDefinition {
            name: ToolName::new("second").unwrap(),
            description: "Second tool".into(),
            parameters: json!({"type": "object"}),
            strict: true,
        },
    ];
    let canonical = request.clone();

    let first = build_request("claude-test", &request).unwrap();
    let second = build_request("claude-test", &request).unwrap();

    assert_eq!(request, canonical);
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert!(first["tools"][0].get("cache_control").is_none());
    assert_eq!(
        first["tools"][1]["cache_control"],
        json!({"type": "ephemeral"})
    );
    assert_eq!(
        first["system"][0]["cache_control"],
        json!({"type": "ephemeral"})
    );
    assert!(
        first["messages"][0]["content"][0]
            .get("cache_control")
            .is_none()
    );
    assert_eq!(
        first["messages"][2]["content"][0]["cache_control"],
        json!({"type": "ephemeral"})
    );
}

#[test]
fn explicit_cache_breakpoint_can_end_at_a_completed_tool_result() {
    let call_id = ToolCallId::new("call-1").unwrap();
    let mut assistant = Message::text(MessageRole::Assistant, "checking");
    assistant.tool_calls.push(ToolCall {
        id: call_id.clone(),
        name: ToolName::new("lookup").unwrap(),
        arguments: json!({"query": "value"}),
    });
    let mut request = ModelRequest::text("follow up");
    request.input = vec![
        InputItem::Message(Message::text(MessageRole::User, "initial")),
        InputItem::Message(assistant),
        InputItem::ToolResult(crate::ToolResult {
            call_id,
            name: ToolName::new("lookup").unwrap(),
            content: vec![ContentPart::Text("result".into())],
            is_error: false,
        }),
        InputItem::Message(Message::text(MessageRole::User, "follow up")),
    ];
    request.prompt_cache_prefix_end = Some(2);

    let built = build_request("claude-test", &request).unwrap();

    assert!(
        built["messages"][0]["content"][0]
            .get("cache_control")
            .is_none()
    );
    assert!(
        built["messages"][3]["content"][0]
            .get("cache_control")
            .is_none()
    );
    assert_eq!(
        built["messages"][2]["content"][0]["cache_control"],
        json!({"type": "ephemeral"})
    );
}

#[test]
fn cache_scope_changes_for_a_different_model_or_compacted_history() {
    let mut request = ModelRequest::text("latest request");
    request.instructions = Some("stable instructions".into());
    request.input.insert(
        0,
        InputItem::Message(Message::text(MessageRole::User, "earlier request")),
    );
    request.input.insert(
        1,
        InputItem::Message(Message::text(MessageRole::Assistant, "earlier answer")),
    );
    request.prompt_cache_prefix_end = Some(2);

    let first = build_request("claude-primary", &request).unwrap();
    let other_model = build_request("claude-secondary", &request).unwrap();
    assert_ne!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&other_model).unwrap()
    );
    assert_eq!(first["model"], "claude-primary");
    assert_eq!(other_model["model"], "claude-secondary");

    let mut compacted = request.clone();
    compacted.input = vec![
        InputItem::Message(Message::text(
            MessageRole::User,
            "Summary of the earlier conversation",
        )),
        InputItem::Message(Message::text(MessageRole::User, "latest request")),
    ];
    compacted.prompt_cache_prefix_end = Some(1);
    let compacted = build_request("claude-primary", &compacted).unwrap();
    assert_ne!(first["messages"], compacted["messages"]);
    assert_eq!(
        compacted["messages"][1]["content"][0]["cache_control"],
        json!({"type": "ephemeral"})
    );
}

#[test]
fn converts_remote_image_to_anthropic_url_source() {
    let converted = convert_content(&ContentPart::ImageUrl {
        url: "https://example.com/image.png".into(),
        detail: ImageDetail::Auto,
    })
    .unwrap();

    assert_eq!(
        converted,
        json!({
            "type": "image",
            "source": {
                "type": "url",
                "url": "https://example.com/image.png",
            },
        })
    );
}

#[test]
fn converts_data_url_to_anthropic_base64_source() {
    let converted = convert_content(&ContentPart::ImageUrl {
        url: "data:image/png;base64,iVBORw0KGgo=".into(),
        detail: ImageDetail::Auto,
    })
    .unwrap();

    assert_eq!(
        converted,
        json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": "iVBORw0KGgo=",
            },
        })
    );
}

#[test]
fn rejects_unsupported_image_data_url() {
    let result = convert_content(&ContentPart::ImageUrl {
        url: "data:image/svg+xml;base64,PHN2Zz4=".into(),
        detail: ImageDetail::Auto,
    });

    assert!(matches!(result, Err(ApiError::InvalidRequest(_))));
}
