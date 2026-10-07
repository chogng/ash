use super::*;
use crate::ApiError;
use ash_client::{SseEvent, SseFrame};
use ash_protocol::ModelStreamEvent;

fn event(event: &str, data: &str) -> SseFrame {
    SseFrame::Event(SseEvent {
        event: Some(event.into()),
        data: data.into(),
        id: None,
        retry: None,
    })
}

#[test]
fn messages_decoder_validates_text_lifecycle_and_ignores_ping() {
    let mut decoder = AnthropicMessagesSseDecoder::new();
    decoder
        .decode(&event("message_start", r#"{"type":"message_start"}"#))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#,
        ))
        .unwrap();
    assert_eq!(
        decoder
            .decode(&event(
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
            ))
            .unwrap(),
        vec![ModelStreamEvent::TextDelta("Hello".into())]
    );
    assert!(
        decoder
            .decode(&event("ping", r#"{"type":"ping"}"#))
            .unwrap()
            .is_empty()
    );
    decoder
        .decode(&event(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ))
        .unwrap();
    decoder
        .decode(&event("message_stop", r#"{"type":"message_stop"}"#))
        .unwrap();
    decoder.finish().unwrap();
}

#[test]
fn messages_decoder_separates_thinking_and_tool_json_deltas() {
    let mut decoder = AnthropicMessagesSseDecoder::new();
    decoder
        .decode(&event("message_start", r#"{"type":"message_start"}"#))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}"#,
        ))
        .unwrap();
    assert_eq!(
        decoder
            .decode(&event(
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}"#,
            ))
            .unwrap(),
        vec![ModelStreamEvent::ReasoningDelta("Plan".into())]
    );
    decoder
        .decode(&event(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use"}}"#,
        ))
        .unwrap();
    assert!(decoder
        .decode(&event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}"#,
        ))
        .unwrap()
        .is_empty());
}

#[test]
fn messages_decoder_rejects_delta_before_its_block_start() {
    let mut decoder = AnthropicMessagesSseDecoder::new();
    decoder
        .decode(&event("message_start", r#"{"type":"message_start"}"#))
        .unwrap();
    assert!(matches!(
        decoder.decode(&event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        )),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn messages_decoder_rejects_message_stop_with_open_blocks() {
    let mut decoder = AnthropicMessagesSseDecoder::new();
    decoder
        .decode(&event("message_start", r#"{"type":"message_start"}"#))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#,
        ))
        .unwrap();
    assert!(matches!(
        decoder.decode(&event("message_stop", r#"{"type":"message_stop"}"#)),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn messages_decoder_classifies_provider_error_events() {
    let mut decoder = AnthropicMessagesSseDecoder::new();
    assert_eq!(
        decoder.decode(&event(
            "error",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
        )),
        Err(ApiError::Overloaded)
    );
}

#[test]
fn messages_decoder_assembles_terminal_text_tool_arguments_and_usage() {
    let mut decoder = AnthropicMessagesSseDecoder::new();
    decoder
        .decode(&event(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_1","content":[],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":0}}}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"weather","input":{}}}"#,
        ))
        .unwrap();
    for fragment in ["{\"city\":\"", "Paris\"}"] {
        decoder
            .decode(&event(
                "content_block_delta",
                &format!(
                    r#"{{"type":"content_block_delta","index":1,"delta":{{"type":"input_json_delta","partial_json":{}}}}}"#,
                    serde_json::to_string(fragment).unwrap()
                ),
            ))
            .unwrap();
    }
    decoder
        .decode(&event(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":7}}"#,
        ))
        .unwrap();
    decoder
        .decode(&event("message_stop", r#"{"type":"message_stop"}"#))
        .unwrap();

    let response = decoder.finish_response().unwrap();
    assert_eq!(response["content"][0]["text"], "Hello");
    assert_eq!(response["content"][1]["input"]["city"], "Paris");
    assert_eq!(response["stop_reason"], "tool_use");
    assert_eq!(response["usage"]["input_tokens"], 12);
    assert_eq!(response["usage"]["output_tokens"], 7);
}
