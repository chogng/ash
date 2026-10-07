use super::*;
use ash_protocol::Message;
use ash_protocol::MessageRole;
use ash_protocol::ToolCallId;
use ash_protocol::ToolChoice;
use ash_protocol::ToolName;
use ash_protocol::ToolResult;

#[test]
fn model_request_final_gate_sanitizes_message_and_tool_result_images() {
    let mut request = ModelRequest {
        verbosity: None,
        reasoning_summary: None,
        service_tier: None,
        speed: None,
        instructions: None,
        input: vec![
            InputItem::Message(Message {
                role: MessageRole::User,
                content: vec![ContentPart::ImageUrl {
                    url: "data:image/png;base64,AA==".into(),
                    detail: ImageDetail::Original,
                }],
                tool_calls: Vec::new(),
            }),
            InputItem::ToolResult(ToolResult {
                call_id: ToolCallId::new("tool_1").unwrap(),
                name: ToolName::new("image").unwrap(),
                content: vec![ContentPart::ImageUrl {
                    url: "data:image/png;base64,AA==".into(),
                    detail: ImageDetail::Original,
                }],
                is_error: false,
            }),
        ],
        tools: Vec::new(),
        tool_choice: ToolChoice::Auto,
        parallel_tool_calls: false,
        reasoning: None,
        max_output_tokens: None,
        temperature: None,
        prompt_cache_key: None,
        prompt_cache_prefix_end: Some(0),
    };

    normalize_image_details(&mut request, CapabilitySupport::Unsupported);

    for item in &request.input {
        let content = match item {
            InputItem::Message(message) => &message.content,
            InputItem::ToolResult(result) => &result.content,
            InputItem::Reasoning(_) => panic!("unexpected reasoning item"),
        };
        assert!(matches!(
            content.as_slice(),
            [ContentPart::ImageUrl {
                detail: ImageDetail::Auto,
                ..
            }]
        ));
    }
}
