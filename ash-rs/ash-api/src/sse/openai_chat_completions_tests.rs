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
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]},"finish_reason":null}]}"#,
        ))
        .unwrap();
    decoder
        .decode(&data(
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}"#,
        ))
        .unwrap();
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
