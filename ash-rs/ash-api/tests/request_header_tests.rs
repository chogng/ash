use ash_api::ApiEndpoint;
use ash_api::ApiError;
use ash_api::ApiStreamSink;
use ash_api::ContentPart;
use ash_api::ImageDetail;
use ash_api::InputItem;
use ash_api::InputTokenCountEndpoint;
use ash_api::Message;
use ash_api::MessageRole;
use ash_api::ModelRequest;
use ash_api::ModelStreamEvent;
use ash_api::ToolCall;
use ash_api::ToolCallId;
use ash_api::ToolName;
use ash_api::ToolResult;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpHeader;
use serde_json::Value;
use serde_json::json;
use std::sync::Mutex;

#[derive(Default)]
struct HeaderCapture(Mutex<Option<ClientRequest>>);
impl OperationClient for HeaderCapture {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        *self.0.lock().unwrap() = Some(request.clone());
        Err(ClientError::Transport("captured".into()))
    }
    fn execute_streaming(
        &self,
        request: &ClientRequest,
        _: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.execute(request)
    }
}
struct IgnoreEvents;
impl ApiStreamSink for IgnoreEvents {
    fn emit(&mut self, _: ModelStreamEvent) -> Result<(), ApiError> {
        Ok(())
    }
}

fn header<'a>(request: &'a ClientRequest, name: &str) -> Option<&'a str> {
    let values = request
        .headers()
        .iter()
        .filter(|header| header.name().eq_ignore_ascii_case(name))
        .map(|header| header.value())
        .collect::<Vec<_>>();
    assert!(values.len() <= 1, "duplicate {name}");
    values.first().copied()
}

#[test]
fn every_generation_profile_builds_json_and_stream_headers_at_the_api_boundary() {
    for endpoint in [
        ApiEndpoint::OpenAiResponses,
        ApiEndpoint::ChatGptResponses,
        ApiEndpoint::OpenAiChatCompletions,
        ApiEndpoint::DeepSeekChatCompletions,
        ApiEndpoint::XaiChatCompletions,
        ApiEndpoint::AnthropicMessages,
        ApiEndpoint::AnthropicMessagesAtBase,
    ] {
        for streaming in [false, true] {
            let target = ResolvedApiTarget::new(
                "https://example.test/v1",
                vec![
                    HttpHeader::new("Authorization", "Bearer test-credential"),
                    HttpHeader::new("X-Client-Marker", "fixture"),
                ],
            );
            let original = target.clone();
            let capture = HeaderCapture::default();
            let mut input = ModelRequest::text("synthetic input");
            input.prompt_cache_key = Some("session-one".into());
            let error = if streaming {
                endpoint
                    .stream_with_client_and_cancellation(
                        &target,
                        "gpt-5.6-luna",
                        &input,
                        &capture,
                        &CancellationSource::new().token(),
                        &mut IgnoreEvents,
                    )
                    .unwrap_err()
            } else {
                endpoint
                    .complete_with_client(&target, "gpt-5.6-luna", &input, &capture)
                    .unwrap_err()
            };
            assert!(matches!(error, ApiError::Transport(_)), "{error:?}");
            let request = capture
                .0
                .lock()
                .unwrap()
                .clone()
                .expect("endpoint must reach the transport");
            assert_eq!(header(&request, "content-type"), Some("application/json"));
            assert_eq!(
                header(&request, "accept"),
                Some(if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                })
            );
            assert_eq!(
                header(&request, "authorization"),
                Some("Bearer test-credential")
            );
            assert_eq!(header(&request, "x-client-marker"), Some("fixture"));
            assert_eq!(
                header(&request, "session-id"),
                (endpoint == ApiEndpoint::ChatGptResponses).then_some("session-one")
            );
            assert_eq!(
                header(&request, "anthropic-version"),
                matches!(
                    endpoint,
                    ApiEndpoint::AnthropicMessages | ApiEndpoint::AnthropicMessagesAtBase
                )
                .then_some("2023-06-01")
            );
            assert_eq!(
                header(&request, "x-grok-conv-id"),
                (endpoint == ApiEndpoint::XaiChatCompletions).then_some("session-one")
            );
            assert_eq!(target, original);
            let body: Value = serde_json::from_slice(request.body()).unwrap();
            if matches!(
                endpoint,
                ApiEndpoint::OpenAiResponses | ApiEndpoint::ChatGptResponses
            ) {
                assert_eq!(
                    body["input"][0]["content"][0]
                        .get("prompt_cache_breakpoint")
                        .is_some(),
                    endpoint == ApiEndpoint::OpenAiResponses
                );
            }
            assert_eq!(input.prompt_cache_prefix_end, Some(0));
        }
    }
}

#[test]
fn header_collisions_are_case_insensitive_and_rejected_without_sending_or_disclosing_values() {
    for headers in [
        vec![
            HttpHeader::new("Authorization", "Bearer private-a"),
            HttpHeader::new("authorization", "Bearer private-b"),
        ],
        vec![HttpHeader::new("Content-Type", "text/plain")],
        vec![HttpHeader::new("X-Test", "private\r\nInjected: private")],
        vec![HttpHeader::new("bad header", "private")],
        vec![HttpHeader::new("session-id", "wrong-private-scope")],
    ] {
        let target = ResolvedApiTarget::new("https://example.test", headers);
        let capture = HeaderCapture::default();
        let mut request = ModelRequest::text("input");
        request.prompt_cache_key = Some("correct-scope".into());
        let error = ApiEndpoint::ChatGptResponses
            .complete_with_client(&target, "gpt-5.6-luna", &request, &capture)
            .unwrap_err();
        assert!(matches!(error, ApiError::InvalidRequest(_)));
        assert!(!error.to_string().contains("private"));
        assert!(capture.0.lock().unwrap().is_none());
    }
    let capture = HeaderCapture::default();
    let target = ResolvedApiTarget::new(
        "https://example.test",
        vec![
            HttpHeader::new("content-type", "application/json"),
            HttpHeader::new("Content-Type", "application/json"),
        ],
    );
    let _ = ApiEndpoint::OpenAiResponses.complete_with_client(
        &target,
        "gpt-5.6-luna",
        &ModelRequest::text("input"),
        &capture,
    );
    assert_eq!(
        header(capture.0.lock().unwrap().as_ref().unwrap(), "content-type"),
        Some("application/json")
    );
}

#[test]
fn preflight_has_json_headers_and_subscription_preflight_is_rejected() {
    for endpoint in [
        InputTokenCountEndpoint::OpenAiResponses,
        InputTokenCountEndpoint::AnthropicMessages,
        InputTokenCountEndpoint::GoogleGenerateContent,
        InputTokenCountEndpoint::KimiChatCompletions,
        InputTokenCountEndpoint::ZaiChatCompletions,
    ] {
        let capture = HeaderCapture::default();
        let target = ResolvedApiTarget::new("https://example.test", Vec::new());
        endpoint
            .count_with_client(
                &target,
                "fixture-model",
                &ModelRequest::text("input"),
                &capture,
            )
            .unwrap_err();
        let request = capture
            .0
            .lock()
            .unwrap()
            .clone()
            .expect("preflight must reach the transport");
        assert_eq!(header(&request, "content-type"), Some("application/json"));
        assert_eq!(header(&request, "accept"), Some("application/json"));
        assert_eq!(header(&request, "session-id"), None);
    }
    let capture = HeaderCapture::default();
    let error = ApiEndpoint::ChatGptResponses
        .count_input_tokens_with_client(
            &ResolvedApiTarget::new("https://example.test", Vec::new()),
            "gpt-5.6-luna",
            &ModelRequest::text("input"),
            &capture,
        )
        .unwrap_err();
    assert!(matches!(error, ApiError::InvalidRequest(_)));
    assert!(capture.0.lock().unwrap().is_none());
}

#[test]
fn subscription_preserves_structured_tool_results_while_omitting_cache_breakpoints() {
    let mut request = ModelRequest::text("question");
    let call = ToolCall {
        id: ToolCallId::new("call").unwrap(),
        name: ToolName::new("inspect").unwrap(),
        arguments: json!({}),
    };
    request.input.push(InputItem::Message(Message {
        role: MessageRole::Assistant,
        content: vec![],
        tool_calls: vec![call.clone()],
    }));
    request.input.push(InputItem::ToolResult(ToolResult {
        call_id: call.id,
        name: call.name,
        content: vec![
            ContentPart::Text("result".into()),
            ContentPart::ImageUrl {
                url: "data:image/png;base64,aGVsbG8=".into(),
                detail: ImageDetail::Low,
            },
        ],
        is_error: false,
    }));
    request.prompt_cache_prefix_end = Some(2);
    for endpoint in [ApiEndpoint::OpenAiResponses, ApiEndpoint::ChatGptResponses] {
        let capture = HeaderCapture::default();
        endpoint
            .complete_with_client(
                &ResolvedApiTarget::new("https://example.test", vec![]),
                "gpt-5.6-luna",
                &request,
                &capture,
            )
            .unwrap_err();
        let captured = capture.0.lock().unwrap().clone().unwrap();
        let body: Value = serde_json::from_slice(captured.body()).unwrap();
        let output = body["input"][2]["output"].as_array().unwrap();
        assert_eq!(output[0]["text"], "result");
        assert_eq!(output[1]["type"], "input_image");
        assert_eq!(
            output[1].get("prompt_cache_breakpoint").is_some(),
            endpoint == ApiEndpoint::OpenAiResponses
        );
    }
}
