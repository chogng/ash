use super::OpenAiChatCompletionsSseDecoder;
use crate::ApiError;
use ash_client::SseEvent;
use ash_client::SseFrame;
use ash_protocol::ModelStreamEvent;
use serde_json::json;

fn data(value: &str) -> SseFrame {
    SseFrame::Event(SseEvent {
        event: None,
        data: value.into(),
        id: None,
        retry: None,
    })
}

#[test]
fn decoder_retains_code_matches_from_annotation_only_chunks() {
    let mut decoder = OpenAiChatCompletionsSseDecoder::new();
    let annotations = json!({"choices":[{"index":0,"delta":{"copilot_annotations":{
        "IPCodeCitations":[
            {"citations":{"url":"https://github.com/example/repo/blob/main/lib.rs","license":"MIT","snippet":"fn example() {}"}},
            {"citations":{"url":"file:///private/lib.rs","license":"MIT","snippet":"private"}}
        ]
    }}}]});
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"content":"An example"}}]}"#,
        ))
        .unwrap();
    for _ in 0..2 {
        assert!(
            decoder
                .decode(&data(&annotations.to_string()))
                .unwrap()
                .is_empty()
        );
    }
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        ))
        .unwrap();
    decoder.decode(&data("[DONE]")).unwrap();
    assert_eq!(
        decoder.take_citations(),
        vec![ash_protocol::ResponseCitation::Code {
            url: "https://github.com/example/repo/blob/main/lib.rs".into(),
            license: "MIT".into(),
            snippet: "fn example() {}".into(),
        }]
    );
    assert_eq!(
        decoder.finish_response().unwrap()["choices"][0]["message"]["content"],
        "An example"
    );
}

#[test]
fn decoder_streams_text_reasoning_and_reassembles_tool_calls() {
    let mut decoder = OpenAiChatCompletionsSseDecoder::new();
    assert_eq!(
        decoder
            .decode(&data(
                r#"{"choices":[{"index":0,"delta":{"content":"Hel","reasoning_content":"Plan "},"finish_reason":null}]}"#,
            ))
            .unwrap(),
        vec![
            ModelStreamEvent::TextDelta("Hel".into()),
            ModelStreamEvent::ReasoningDelta("Plan ".into()),
        ]
    );
    let events = decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]},"finish_reason":null}]}"#,
        ))
        .unwrap();
    assert_eq!(
        events,
        vec![
            ModelStreamEvent::TextDelta("lo".into()),
            ModelStreamEvent::ToolCallDelta {
                id: "call_1".into(),
                name: "weather".into(),
                arguments: "{\"city\":".into()
            }
        ]
    );
    let events = decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}"#,
        ))
        .unwrap();
    assert_eq!(
        events,
        vec![ModelStreamEvent::ToolCallDelta {
            id: "call_1".into(),
            name: "weather".into(),
            arguments: "\"Paris\"}".into()
        }]
    );
    decoder.decode(&data("[DONE]")).unwrap();

    let response = decoder.finish_response().unwrap();
    assert_eq!(response["choices"][0]["message"]["content"], "Hello");
    assert_eq!(
        response["choices"][0]["message"]["reasoning_content"],
        "Plan "
    );
    assert_eq!(
        response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"city\":\"Paris\"}"
    );
    assert_eq!(response["usage"]["prompt_tokens"], 9);
}

#[test]
fn decoder_requires_a_terminal_choice_before_done() {
    let mut decoder = OpenAiChatCompletionsSseDecoder::new();
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}"#,
        ))
        .unwrap();
    assert!(matches!(
        decoder.decode(&data("[DONE]")),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn decoder_rejects_invalid_tool_arguments_at_completion() {
    let mut decoder = OpenAiChatCompletionsSseDecoder::new();
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{"}}]},"finish_reason":"tool_calls"}]}"#,
        ))
        .unwrap();
    decoder.decode(&data("[DONE]")).unwrap();
    assert!(matches!(
        decoder.finish_response(),
        Err(ApiError::InvalidResponse(_))
    ));
}

#[test]
fn decoder_ignores_usage_only_chunks_without_losing_usage() {
    let mut decoder = OpenAiChatCompletionsSseDecoder::new();
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}"#,
        ))
        .unwrap();
    decoder
        .decode(&data(
            &json!({
                "choices": [],
                "usage": {"prompt_tokens": 2, "completion_tokens": 1}
            })
            .to_string(),
        ))
        .unwrap();
    decoder.decode(&data("[DONE]")).unwrap();
    assert_eq!(
        decoder.finish_response().unwrap()["usage"]["completion_tokens"],
        1
    );
}
