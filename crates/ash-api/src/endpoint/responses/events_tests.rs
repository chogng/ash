use super::*;
use crate::ApiError;
use ash_client::{SseEvent, SseFrame};
use ash_protocol::ModelStreamEvent;
use serde_json::json;

fn event(event: &str, data: &str) -> SseFrame {
    SseFrame::Event(SseEvent {
        event: Some(event.into()),
        data: data.into(),
        id: None,
        retry: None,
    })
}

#[test]
fn responses_decoder_emits_text_and_reasoning_deltas() {
    let mut decoder = ResponsesEventDecoder::new();

    assert_eq!(
        decoder
            .decode(&event(
                "response.output_text.delta",
                r#"{"type":"response.output_text.delta","delta":"Hello"}"#,
            ))
            .unwrap(),
        vec![ModelStreamEvent::TextDelta("Hello".into())]
    );
    assert_eq!(
        decoder
            .decode(&event(
                "response.reasoning_summary_text.delta",
                r#"{"type":"response.reasoning_summary_text.delta","delta":"Thinking"}"#,
            ))
            .unwrap(),
        vec![ModelStreamEvent::ReasoningDelta("Thinking".into())]
    );
    decoder
        .decode(&event(
            "response.completed",
            r#"{"type":"response.completed"}"#,
        ))
        .unwrap();
    decoder.finish().unwrap();
}

#[test]
fn responses_decoder_ignores_comments_and_unknown_optional_events() {
    let mut decoder = ResponsesEventDecoder::new();
    assert!(decoder.decode(&SseFrame::Comment).unwrap().is_empty());
    assert!(
        decoder
            .decode(&event("response.created", r#"{"type":"response.created"}"#,))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn responses_decoder_rejects_eof_before_a_terminal_event() {
    let decoder = ResponsesEventDecoder::new();
    assert!(matches!(
        decoder.finish(),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn responses_decoder_rejects_malformed_delta_events() {
    let mut decoder = ResponsesEventDecoder::new();
    assert!(matches!(
        decoder.decode(&event(
            "response.output_text.delta",
            r#"{"type":"response.output_text.delta"}"#,
        )),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn responses_decoder_classifies_terminal_provider_failures() {
    let mut decoder = ResponsesEventDecoder::new();
    assert!(matches!(
        decoder.decode(&event(
            "response.failed",
            r#"{"type":"response.failed","response":{"error":{"code":"context_length_exceeded"}}}"#,
        )),
        Err(ApiError::ContextOverflow(_))
    ));
}

#[test]
fn responses_decoder_orders_completed_items_and_deduplicates_terminal_snapshots() {
    let items = json!([
        {"type": "message", "content": [{"type": "output_text", "text": "Hello"}]},
        {"type": "function_call", "call_id": "call_1", "name": "weather", "arguments": "{}"}
    ]);
    for snapshot in [json!([]), items.clone()] {
        let mut decoder = ResponsesEventDecoder::new();
        for index in [1, 0] {
            decoder
                .decode(&event(
                    "response.output_item.done",
                    &json!({
                        "output_index": index, "item": items[index]
                    })
                    .to_string(),
                ))
                .unwrap();
        }
        decoder
            .decode(&event(
                "response.completed",
                &json!({
                    "response": {"id": "resp_1", "output": snapshot, "usage": {"output_tokens": 12}}
                })
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            decoder.finish_response().unwrap(),
            json!({
                "id": "resp_1", "output": items, "usage": {"output_tokens": 12}
            })
        );
    }
}

#[test]
fn responses_decoder_rejects_malformed_or_repeated_completed_items() {
    for payload in [
        json!({"item": {"type": "message"}}),
        json!({"output_index": -1, "item": {"type": "message"}}),
        json!({"output_index": 0, "item": null}),
    ] {
        let mut decoder = ResponsesEventDecoder::new();
        assert!(matches!(
            decoder.decode(&event("response.output_item.done", &payload.to_string())),
            Err(ApiError::InvalidResponse(_))
        ));
    }
    let mut decoder = ResponsesEventDecoder::new();
    let item = event(
        "response.output_item.done",
        r#"{"output_index":0,"item":{"type":"message"}}"#,
    );
    decoder.decode(&item).unwrap();
    assert!(matches!(
        decoder.decode(&item),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn responses_decoder_requires_complete_consistent_output_and_a_terminal_event() {
    let completed = event("response.completed", r#"{"response":{"output":[]}}"#);
    for index in [0, 1] {
        let mut decoder = ResponsesEventDecoder::new();
        decoder
            .decode(&event(
                "response.output_item.done",
                &json!({
                    "output_index": index, "item": {"type": "message"}
                })
                .to_string(),
            ))
            .unwrap();
        if index == 1 {
            decoder.decode(&completed).unwrap();
        }
        assert!(matches!(
            decoder.finish_response(),
            Err(ApiError::InvalidResponse(_))
        ));
    }
    let mut decoder = ResponsesEventDecoder::new();
    decoder
        .decode(&event(
            "response.output_item.done",
            r#"{"output_index":0,"item":{"type":"message"}}"#,
        ))
        .unwrap();
    decoder
        .decode(&event(
            "response.completed",
            r#"{"response":{"output":[{"type":"function_call"}]}}"#,
        ))
        .unwrap();
    assert!(matches!(
        decoder.finish_response(),
        Err(ApiError::InvalidResponse(_))
    ));
}
