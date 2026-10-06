use super::*;
use crate::ImageDetail;
use crate::ReasoningConfig;

#[test]
fn responses_request_settings_are_rejected_by_messages() {
    for (verbosity, summary) in [
        (Some(ash_protocol::ModelVerbosity::High), None),
        (None, Some(ash_protocol::ModelReasoningSummary::Detailed)),
    ] {
        let mut request = ModelRequest::text("hello");
        request.verbosity = verbosity;
        request.reasoning_summary = summary;
        assert!(build_request("test", &request).is_err());
    }
}

#[test]
fn provider_prelude_preserves_canonical_content_and_cache_budget() {
    let mut request = ModelRequest::text("latest request");
    request.instructions = Some("Ash instructions".into());
    request.tools.push(ToolDefinition {
        name: ToolName::new("read_file").unwrap(),
        description: "Read a file".into(),
        parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        strict: true,
    });
    let canonical = request.clone();
    let ordinary = build_request("test-model", &request).unwrap();
    let mut prefixed =
        build_request_with_prelude("test-model", &request, &["identity", "harness"]).unwrap();
    assert_eq!(
        prefixed["system"],
        json!([
            {"type": "text", "text": "identity"},
            {"type": "text", "text": "harness"},
            {"type": "text", "text": "Ash instructions", "cache_control": {"type": "ephemeral"}}
        ])
    );
    prefixed["system"] = ordinary["system"].clone();
    assert_eq!(prefixed, ordinary);
    assert_eq!(request, canonical);

    request.instructions = None;
    let prefixed =
        build_request_with_prelude("test-model", &request, &["identity", "harness"]).unwrap();
    assert_eq!(prefixed["system"].as_array().unwrap().len(), 2);
    assert!(
        prefixed["system"]
            .as_array()
            .unwrap()
            .iter()
            .all(|block| block.get("cache_control").is_none())
    );
}

#[test]
fn fast_mode_uses_speed_and_preserves_existing_beta_headers() {
    let mut request = ModelRequest::text("hello");
    request.speed = Some(ash_protocol::ModelSpeed::Fast);
    request.service_tier = Some("standard_only".into());
    assert_eq!(
        build_request("claude-opus-5-5", &request).unwrap()["speed"],
        "fast"
    );
    assert!(
        build_count_request("claude-opus-5-5", &request)
            .unwrap()
            .get("speed")
            .is_none()
    );
    let mut values = vec![ash_http_client::HttpHeader::new(
        "anthropic-beta",
        "other-beta",
    )];
    headers(&request, &mut values).unwrap();
    headers(&request, &mut values).unwrap();
    assert_eq!(
        values
            .iter()
            .find(|header| header.name() == "anthropic-beta")
            .unwrap()
            .value(),
        "other-beta,fast-mode-2026-02-01"
    );
    request.speed = None;
    request.service_tier = Some("standard_only".into());
    assert!(
        build_request("claude-opus-5-5", &request)
            .unwrap()
            .get("speed")
            .is_none()
    );
    let mut values = Vec::new();
    headers(&request, &mut values).unwrap();
    assert!(
        values
            .iter()
            .all(|header| header.name() != "anthropic-beta")
    );
    assert_eq!(
        build_request("claude-opus-5-5", &request).unwrap()["service_tier"],
        "standard_only"
    );
    request.service_tier = Some("auto".into());
    assert_eq!(
        build_request("claude-sonnet-4-6", &request).unwrap()["service_tier"],
        "auto"
    );
    assert!(
        build_request("claude-sonnet-4-6", &request)
            .unwrap()
            .get("speed")
            .is_none()
    );
    assert!(
        build_count_request("claude-sonnet-4-6", &request)
            .unwrap()
            .get("service_tier")
            .is_none()
    );
}

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
