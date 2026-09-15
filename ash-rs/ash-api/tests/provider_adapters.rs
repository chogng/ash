use ash_api::{
    ApiEndpoint, ApiError, ApiProtocol, ApiStreamSink, ContentPart, ImageDetail, InputItem,
    InputTokenCountEndpoint, Message, MessageRole, ModelRequest, ModelStreamEvent, OutputItem,
    ReasoningConfig, ReasoningEffort, SemanticApiEndpoint, StopReason, ToolCall, ToolCallId,
    ToolDefinition, ToolName, ToolResult,
};
use ash_async_utils::CancellationSource;
use ash_client::{
    ClientError, ClientRequest, ClientResponse, OperationClient, OperationStreamSink,
    ResolvedApiTarget,
};
use ash_http_client::HttpHeader;
use serde_json::{Value, json};
use std::sync::Mutex;

struct CapturingTransport {
    request: Mutex<Option<(String, Vec<HttpHeader>, Value)>>,
    response: Value,
}

impl CapturingTransport {
    fn new(response: Value) -> Self {
        Self {
            request: Mutex::new(None),
            response,
        }
    }
}

impl OperationClient for CapturingTransport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        let body = serde_json::from_slice(request.body())
            .map_err(|_| ClientError::InvalidRequest("API codec did not produce JSON".into()))?;
        *self.request.lock().unwrap() =
            Some((request.url().into(), request.headers().to_vec(), body));
        let response = serde_json::to_vec(&self.response)
            .map_err(|_| ClientError::InvalidResponse("test response did not encode".into()))?;
        Ok(ClientResponse::new(200, Vec::new(), response))
    }
}

struct StreamingResponsesTransport {
    request: Mutex<Option<Value>>,
}

impl OperationClient for StreamingResponsesTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("Responses streaming must not use unary execution")
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        *self.request.lock().unwrap() = Some(serde_json::from_slice(request.body()).unwrap());
        let payload = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n",
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\"}]}]}}\n\n",
        );
        for chunk in payload.as_bytes().chunks(37) {
            sink.emit(chunk)?;
        }
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct StreamingPayloadTransport {
    request: Mutex<Option<Value>>,
    payload: &'static str,
    chunk_size: usize,
}

impl StreamingPayloadTransport {
    fn new(payload: &'static str, chunk_size: usize) -> Self {
        Self {
            request: Mutex::new(None),
            payload,
            chunk_size,
        }
    }
}

impl OperationClient for StreamingPayloadTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("native streaming must not use unary execution")
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        *self.request.lock().unwrap() = Some(serde_json::from_slice(request.body()).unwrap());
        for chunk in self.payload.as_bytes().chunks(self.chunk_size) {
            sink.emit(chunk)?;
        }
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

#[derive(Default)]
struct RecordedStreamEvents {
    events: Vec<ModelStreamEvent>,
}

impl ApiStreamSink for RecordedStreamEvents {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ApiError> {
        self.events.push(event);
        Ok(())
    }
}

fn target() -> ResolvedApiTarget {
    ResolvedApiTarget::new(
        "https://example.test/v1",
        vec![HttpHeader::new("Authorization", "Bearer secret")],
    )
}

fn tool_request() -> ModelRequest {
    let mut request = ModelRequest::text("weather");
    request.instructions = Some("Use tools when needed.".into());
    request.tools.push(ToolDefinition {
        name: ToolName::new("weather").expect("test tool name is valid"),
        description: "Get weather".into(),
        parameters: json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": false,
        }),
        strict: true,
    });
    request.reasoning = Some(ReasoningConfig {
        effort: ReasoningEffort::Medium,
        summary: true,
    });
    request
}

#[test]
fn openai_strict_tools_reject_invalid_object_schemas_before_transport() {
    let missing_budget = json!({
        "type": "object",
        "properties": {
            "objective": {"type": "string"},
            "token_budget": {"type": ["integer", "null"]}
        },
        "required": ["objective"],
        "additionalProperties": false
    });
    let nested = json!({
        "type": "object",
        "properties": {"steps": {"type": "array", "items": {"anyOf": [missing_budget.clone(), {"type": "null"}]}}},
        "required": ["steps"],
        "additionalProperties": false
    });
    for (schema, detail) in [
        (missing_budget, "required is missing 'token_budget'"),
        (nested, "parameters.properties.steps.items.anyOf[0]"),
        (
            json!({"type": "object", "properties": {}, "required": []}),
            "additionalProperties must be false",
        ),
        (
            json!({"type": "object", "properties": {}, "additionalProperties": false}),
            "required must list every property",
        ),
        (
            json!({"type": "object", "properties": {"x": {}}, "required": ["x", "x"], "additionalProperties": false}),
            "required must list each property exactly once",
        ),
        (
            json!({"type": "object", "properties": {"target": {"oneOf": [{"type": "string"}, {"type": "null"}]}}, "required": ["target"], "additionalProperties": false}),
            "oneOf is not supported",
        ),
    ] {
        for endpoint in [
            ApiEndpoint::OpenAiResponses,
            ApiEndpoint::OpenAiChatCompletions,
        ] {
            let mut request = tool_request();
            request.tools[0].name = ToolName::new("create_goal").unwrap();
            request.tools[0].parameters = schema.clone();
            let transport = CapturingTransport::new(json!({}));
            let error = endpoint
                .complete_with_client(&target(), "model-test", &request, &transport)
                .unwrap_err();
            assert!(
                matches!(error, ApiError::InvalidRequest(ref message) if message.contains("create_goal") && message.contains(detail)),
                "{error:?}"
            );
            let mut events = RecordedStreamEvents::default();
            let stream_error = endpoint
                .stream_with_client_and_cancellation(
                    &target(),
                    "model-test",
                    &request,
                    &transport,
                    &CancellationSource::new().token(),
                    &mut events,
                )
                .unwrap_err();
            assert_eq!(stream_error, error);
            assert!(events.events.is_empty());
            assert!(transport.request.lock().unwrap().is_none());
        }
    }
}

#[test]
fn openai_strict_tools_preserve_nullable_properties_and_schema_annotations() {
    let schema = json!({
        "type": "object",
        "properties": {"token_budget": {
            "type": ["integer", "null"],
            "minimum": 1
        }},
        "required": ["token_budget"],
        "additionalProperties": false,
        "examples": [{"type": "object", "properties": "literal user data"}]
    });
    for strict in [true, false] {
        let mut request = tool_request();
        request.tools[0].parameters = schema.clone();
        request.tools[0].strict = strict;
        if !strict {
            request.tools[0].parameters["required"] = json!([]);
        }
        for endpoint in [
            ApiEndpoint::OpenAiResponses,
            ApiEndpoint::OpenAiChatCompletions,
        ] {
            let transport = CapturingTransport::new(json!({
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}],
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]
            }));
            assert_eq!(
                endpoint
                    .complete_with_client(&target(), "model-test", &request, &transport)
                    .unwrap()
                    .text(),
                "ok"
            );
            let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
            let wire_tool = if endpoint == ApiEndpoint::OpenAiResponses {
                &body["tools"][0]
            } else {
                &body["tools"][0]["function"]
            };
            assert_eq!(wire_tool["parameters"], request.tools[0].parameters);
            assert_eq!(wire_tool["strict"], strict);
        }
    }
}

fn conformance_request() -> ModelRequest {
    let call_id = ToolCallId::new("call_1").unwrap();
    let tool_name = ToolName::new("weather").unwrap();
    let mut request = tool_request();
    request.reasoning = None;
    request.input = vec![
        InputItem::Message(Message {
            role: MessageRole::User,
            content: vec![
                ContentPart::Text("What is the weather?".into()),
                ContentPart::ImageUrl {
                    url: "data:image/png;base64,iVBORw0KGgo=".into(),
                    detail: ImageDetail::Auto,
                },
            ],
            tool_calls: Vec::new(),
        }),
        InputItem::Message(Message {
            role: MessageRole::Assistant,
            content: Vec::new(),
            tool_calls: vec![ToolCall {
                id: call_id.clone(),
                name: tool_name.clone(),
                arguments: json!({"city": "Paris"}),
            }],
        }),
        InputItem::ToolResult(ToolResult {
            call_id,
            name: tool_name,
            content: vec![ContentPart::Text("sunny".into())],
            is_error: false,
        }),
    ];
    request
}

#[test]
fn provider_conformance_matrix_maps_images_tool_calls_results_and_usage() {
    let cases = [
        (
            "responses",
            ApiEndpoint::OpenAiResponses,
            target(),
            json!({
                "id": "resp_1",
                "status": "completed",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "sunny"}]
                }],
                "usage": {"input_tokens": 20, "output_tokens": 4}
            }),
        ),
        (
            "chat",
            ApiEndpoint::OpenAiChatCompletions,
            target(),
            json!({
                "id": "chatcmpl_1",
                "choices": [{
                    "message": {"role": "assistant", "content": "sunny"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 20, "completion_tokens": 4}
            }),
        ),
        (
            "anthropic",
            ApiEndpoint::AnthropicMessages,
            ResolvedApiTarget::new(
                "https://api.anthropic.com",
                vec![HttpHeader::new("x-api-key", "secret")],
            ),
            json!({
                "id": "msg_1",
                "content": [{"type": "text", "text": "sunny"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 20, "output_tokens": 4}
            }),
        ),
    ];

    for (name, endpoint, target, response) in cases {
        let transport = CapturingTransport::new(response);
        let result = endpoint
            .complete_with_client(&target, "model-test", &conformance_request(), &transport)
            .unwrap();
        assert_eq!(result.text(), "sunny", "{name}");
        assert_eq!(result.usage.unwrap().input_tokens, Some(20), "{name}");
        let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
        match name {
            "responses" => {
                assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
                assert_eq!(body["input"][1]["type"], "function_call");
                assert_eq!(body["input"][2]["type"], "function_call_output");
            }
            "chat" => {
                assert_eq!(body["messages"][1]["content"][1]["type"], "image_url");
                assert_eq!(body["messages"][2]["tool_calls"][0]["id"], "call_1");
                assert_eq!(body["messages"][3]["role"], "tool");
            }
            "anthropic" => {
                assert_eq!(body["messages"][0]["content"][1]["type"], "image");
                assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
                assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn provider_conformance_matrix_rejects_unmaterialized_durable_images() {
    let attachment = ash_protocol::ImageAttachmentRef {
        content_digest: ash_protocol::ContentDigest::sha256(b"test-image"),
        media_type: ash_protocol::ImageMediaType::Png,
        encoded_bytes: 10,
        width: 1,
        height: 1,
    };
    let mut request = ModelRequest::text("inspect");
    let InputItem::Message(message) = &mut request.input[0] else {
        unreachable!()
    };
    message.content = vec![ContentPart::ImageAttachment {
        attachment,
        detail: ImageDetail::Auto,
    }];

    for endpoint in [
        ApiEndpoint::OpenAiResponses,
        ApiEndpoint::OpenAiChatCompletions,
        ApiEndpoint::AnthropicMessages,
    ] {
        let transport = CapturingTransport::new(json!({}));
        let error = endpoint
            .complete_with_client(&target(), "model-test", &request, &transport)
            .unwrap_err();
        assert!(matches!(error, ApiError::InvalidRequest(_)));
        assert!(transport.request.lock().unwrap().is_none());
    }

    let transport = CapturingTransport::new(json!({}));
    let error = InputTokenCountEndpoint::GoogleGenerateContent
        .count_with_client(&target(), "gemini-test", &request, &transport)
        .unwrap_err();
    assert!(matches!(error, ApiError::InvalidRequest(_)));
    assert!(transport.request.lock().unwrap().is_none());
}

#[test]
fn provider_conformance_matrix_rejects_local_image_paths_before_transport() {
    let mut request = ModelRequest::text("inspect");
    let InputItem::Message(message) = &mut request.input[0] else {
        unreachable!()
    };
    message.content = vec![ContentPart::ImageUrl {
        url: "file:///Users/example/secret.png".into(),
        detail: ImageDetail::Auto,
    }];

    for endpoint in [
        ApiEndpoint::OpenAiResponses,
        ApiEndpoint::OpenAiChatCompletions,
        ApiEndpoint::AnthropicMessages,
    ] {
        let transport = CapturingTransport::new(json!({}));
        let error = endpoint
            .complete_with_client(&target(), "model-test", &request, &transport)
            .unwrap_err();
        assert!(matches!(error, ApiError::InvalidRequest(_)));
        assert!(transport.request.lock().unwrap().is_none());
    }
}

#[test]
fn provider_conformance_maps_refusals_or_fails_unsupported_output_explicitly() {
    let responses = CapturingTransport::new(json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "content": [{"type": "refusal", "refusal": "cannot comply"}]
        }]
    }));
    let response = ApiEndpoint::OpenAiResponses
        .complete_with_client(
            &target(),
            "gpt-test",
            &ModelRequest::text("hello"),
            &responses,
        )
        .unwrap();
    assert_eq!(
        response.output,
        vec![OutputItem::Refusal("cannot comply".into())]
    );
    assert_eq!(response.stop_reason, StopReason::Refusal);

    let chat = CapturingTransport::new(json!({
        "choices": [{
            "message": {"role": "assistant", "content": null, "refusal": "cannot comply"},
            "finish_reason": "stop"
        }]
    }));
    let response = ApiEndpoint::OpenAiChatCompletions
        .complete_with_client(&target(), "gpt-test", &ModelRequest::text("hello"), &chat)
        .unwrap();
    assert_eq!(
        response.output,
        vec![OutputItem::Refusal("cannot comply".into())]
    );
    assert_eq!(response.stop_reason, StopReason::Refusal);

    let anthropic = CapturingTransport::new(json!({
        "content": [{"type": "unsupported_refusal", "text": "cannot comply"}],
        "stop_reason": "end_turn"
    }));
    let error = ApiEndpoint::AnthropicMessages
        .complete_with_client(
            &ResolvedApiTarget::new(
                "https://api.anthropic.com",
                vec![HttpHeader::new("x-api-key", "secret")],
            ),
            "claude-test",
            &ModelRequest::text("hello"),
            &anthropic,
        )
        .unwrap_err();
    assert!(matches!(error, ApiError::InvalidResponse(_)));
}

#[test]
fn openai_responses_converts_tools_reasoning_and_tool_calls() {
    let transport = CapturingTransport::new(json!({
        "id": "resp_1",
        "model": "gpt-5.6-sol",
        "service_tier": "priority",
        "status": "completed",
        "output": [{
            "type": "function_call",
            "call_id": "call_1",
            "name": "weather",
            "arguments": "{\"city\":\"Paris\"}"
        }],
        "usage": {
            "input_tokens": 20,
            "output_tokens": 5,
            "input_tokens_details": {"cached_tokens": 3, "cache_write_tokens": 4},
            "output_tokens_details": {"reasoning_tokens": 2}
        }
    }));
    let mut model_request = tool_request();
    model_request.prompt_cache_key = Some("session-cache-key".into());
    let response = ApiEndpoint::OpenAiResponses
        .complete_with_client(&target(), "gpt-test", &model_request, &transport)
        .unwrap();

    let (endpoint, headers, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/responses");
    assert_eq!(headers[0].value(), "Bearer secret");
    assert_eq!(request["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(request["tools"][0]["name"], "weather");
    assert_eq!(request["reasoning"]["effort"], "medium");
    assert_eq!(request["prompt_cache_key"], "session-cache-key");
    assert_eq!(response.stop_reason, StopReason::ToolUse);
    let billing = response.billing.as_ref().expect("billing facts");
    assert_eq!(
        billing.resolved_model.as_ref().unwrap().as_str(),
        "gpt-5.6-sol"
    );
    assert_eq!(billing.applied_service_tier.as_deref(), Some("priority"));
    assert_eq!(
        response.tool_calls().next().unwrap().arguments,
        json!({"city": "Paris"})
    );
    let usage = response.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(20));
    assert_eq!(usage.cached_input_tokens, Some(3));
    assert_eq!(usage.cache_write_input_tokens, Some(4));
    assert_eq!(usage.reasoning_tokens, Some(2));
}

#[test]
fn astra_preserves_supported_reasoning_and_round_trips_tool_results() {
    for (effort, wire_effort) in [
        (ReasoningEffort::Low, "low"),
        (ReasoningEffort::Medium, "medium"),
        (ReasoningEffort::High, "high"),
        (ReasoningEffort::ExtraHigh, "xhigh"),
        (ReasoningEffort::Max, "max"),
    ] {
        let transport = CapturingTransport::new(json!({
            "id": "resp_astra",
            "model": "gpt-6-astra",
            "status": "completed",
            "output": [{
                "type": "function_call",
                "call_id": "call_astra",
                "name": "weather",
                "arguments": "{\"city\":\"Paris\"}"
            }]
        }));
        let mut request = tool_request();
        request.reasoning.as_mut().unwrap().effort = effort;
        request.prompt_cache_key = Some("astra-session".into());
        let response = ApiEndpoint::OpenAiResponses
            .complete_with_client(&target(), "gpt-6-astra", &request, &transport)
            .unwrap();
        let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
        assert_eq!(body["model"], "gpt-6-astra");
        assert_eq!(body["reasoning"]["effort"], wire_effort);
        assert_eq!(body["tools"][0]["name"], "weather");
        assert_eq!(body["prompt_cache_key"], "astra-session");
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        for field in [
            "temperature",
            "top_p",
            "top_logprobs",
            "prompt_cache_retention",
        ] {
            assert!(body.get(field).is_none(), "unexpected {field}");
        }
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        let call = response.tool_calls().next().unwrap();
        assert_eq!(call.arguments, json!({"city": "Paris"}));
        request.input.push(InputItem::Message(Message {
            role: MessageRole::Assistant,
            content: Vec::new(),
            tool_calls: vec![call.clone()],
        }));
        request.input.push(InputItem::ToolResult(ToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: vec![ContentPart::Text("Sunny".into())],
            is_error: false,
        }));
        ApiEndpoint::OpenAiResponses
            .complete_with_client(&target(), "gpt-6-astra", &request, &transport)
            .unwrap();
        let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
        assert_eq!(body["input"][1]["type"], "function_call");
        assert_eq!(body["input"][1]["call_id"], "call_astra");
        assert_eq!(
            body["input"][2],
            json!({
                "type": "function_call_output",
                "call_id": "call_astra",
                "output": [{"type":"input_text","text":"Sunny"}]
            })
        );
    }
}

#[test]
fn openai_responses_streams_wire_deltas_and_returns_the_terminal_response() {
    let transport = StreamingResponsesTransport {
        request: Mutex::new(None),
    };
    let mut events = RecordedStreamEvents::default();

    let response = ApiEndpoint::OpenAiResponses
        .stream_with_client_and_cancellation(
            &target(),
            "gpt-6-astra",
            &ModelRequest::text("hello"),
            &transport,
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(
        events.events,
        vec![
            ModelStreamEvent::TextDelta("Hel".into()),
            ModelStreamEvent::TextDelta("lo".into()),
        ]
    );
    assert_eq!(response.text(), "Hello");
    assert_eq!(
        transport.request.lock().unwrap().as_ref().unwrap()["stream"],
        true
    );
}

#[test]
fn openai_responses_collects_completed_items_with_terminal_usage() {
    let transport = StreamingPayloadTransport::new(
        concat!(
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"Checking\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"summary\":[{\"text\":\"Checking\"}]}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\"}]}}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":2,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\\\"Paris\\\"}\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":20}}}\n\n",
        ),
        17,
    );
    let mut events = RecordedStreamEvents::default();
    let response = ApiEndpoint::OpenAiResponses
        .stream_with_client_and_cancellation(
            &target(),
            "model-test",
            &tool_request(),
            &transport,
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();
    assert_eq!(
        response.output,
        vec![
            OutputItem::Reasoning("Checking".into()),
            OutputItem::Text("Hello".into()),
            OutputItem::ToolCall(ToolCall {
                id: ToolCallId::new("call_1").unwrap(),
                name: ToolName::new("weather").unwrap(),
                arguments: json!({"city": "Paris"}),
            }),
        ]
    );
    assert_eq!(response.stop_reason, StopReason::ToolUse);
    let usage = response.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(10));
    assert_eq!(usage.output_tokens, Some(20));
    assert_eq!(
        events.events,
        vec![
            ModelStreamEvent::ReasoningDelta("Checking".into()),
            ModelStreamEvent::TextDelta("Hello".into()),
        ]
    );
}

#[test]
fn openai_responses_counts_the_frozen_input_payload() {
    let transport = CapturingTransport::new(json!({"input_tokens": 321}));
    let mut request = tool_request();
    request.max_output_tokens = Some(2_048);
    request.temperature = Some(0.25);
    request.prompt_cache_key = Some("session-cache-key".into());

    let count = ApiEndpoint::OpenAiResponses
        .count_input_tokens_with_client(&target(), "gpt-test", &request, &transport)
        .unwrap();

    let (endpoint, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/responses/input_tokens");
    assert_eq!(count.get(), 321);
    assert_eq!(body["model"], "gpt-test");
    assert_eq!(body["tools"][0]["name"], "weather");
    assert_eq!(body["reasoning"]["effort"], "medium");
    assert_eq!(body["tool_choice"], "auto");
    assert_eq!(body["parallel_tool_calls"], true);
    assert!(body.get("stream").is_none());
    assert!(body.get("max_output_tokens").is_none());
    assert!(body.get("temperature").is_none());
    assert!(body.get("prompt_cache_key").is_none());
}

#[test]
fn chat_completions_endpoint_converts_tools_and_text() {
    let transport = CapturingTransport::new(json!({
        "id": "chatcmpl_1",
        "choices": [{
            "message": {"content": "sunny"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 4, "completion_tokens": 2}
    }));
    let mut request = tool_request();
    request.reasoning = None;
    let response = ApiEndpoint::OpenAiChatCompletions
        .complete_with_client(&target(), "qwen-test", &request, &transport)
        .unwrap();

    let (endpoint, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/chat/completions");
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["tools"][0]["function"]["name"], "weather");
    assert_eq!(response.text(), "sunny");
}

#[test]
fn chat_completions_streams_wire_deltas_and_reassembles_tool_calls() {
    let transport = StreamingPayloadTransport::new(
        concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"sun\",\"reasoning_content\":\"check \"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ny\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Paris\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":5}}\n\n",
            "data: [DONE]\n\n",
        ),
        19,
    );
    let mut events = RecordedStreamEvents::default();

    let response = ApiEndpoint::OpenAiChatCompletions
        .stream_with_client_and_cancellation(
            &target(),
            "qwen-test",
            &tool_request(),
            &transport,
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(
        events.events,
        vec![
            ModelStreamEvent::TextDelta("sun".into()),
            ModelStreamEvent::ReasoningDelta("check ".into()),
            ModelStreamEvent::TextDelta("ny".into()),
        ]
    );
    assert_eq!(response.text(), "sunny");
    assert_eq!(
        response.tool_calls().next().unwrap().arguments,
        json!({"city": "Paris"})
    );
    let usage = response.usage.unwrap();
    assert_eq!(usage.output_tokens, Some(5));
    assert_eq!(usage.cached_input_tokens, None);
    assert_eq!(usage.reasoning_tokens, None);
    let request = transport.request.lock().unwrap();
    assert_eq!(request.as_ref().unwrap()["stream"], true);
    assert_eq!(
        request.as_ref().unwrap()["stream_options"]["include_usage"],
        true
    );
}

#[test]
fn deepseek_chat_completions_maps_cache_hits_and_reasoning_usage() {
    let transport = CapturingTransport::new(json!({
        "id": "chatcmpl_1",
        "choices": [{
            "message": {"content": "done"},
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": 100,
            "prompt_cache_hit_tokens": 75,
            "prompt_cache_miss_tokens": 25,
            "completion_tokens": 12,
            "completion_tokens_details": {"reasoning_tokens": 8}
        }
    }));

    let response = ApiEndpoint::DeepSeekChatCompletions
        .complete_with_client(
            &target(),
            "deepseek-test",
            &ModelRequest::text("hello"),
            &transport,
        )
        .unwrap();

    let usage = response.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.cached_input_tokens, Some(75));
    assert_eq!(usage.cache_write_input_tokens, None);
    assert_eq!(usage.output_tokens, Some(12));
    assert_eq!(usage.reasoning_tokens, Some(8));
}

#[test]
fn anthropic_messages_converts_tools_and_tool_use() {
    let transport = CapturingTransport::new(json!({
        "id": "msg_1",
        "content": [{
            "type": "tool_use",
            "id": "toolu_1",
            "name": "weather",
            "input": {"city": "Paris"}
        }],
        "stop_reason": "tool_use",
        "usage": {
            "input_tokens": 10,
            "cache_creation_input_tokens": 3,
            "cache_read_input_tokens": 7,
            "output_tokens": 4,
            "output_tokens_details": {"thinking_tokens": 2}
        }
    }));
    let mut request = tool_request();
    request.reasoning = None;
    let response = ApiEndpoint::AnthropicMessages
        .complete_with_client(
            &ResolvedApiTarget::new(
                "https://api.anthropic.com",
                vec![HttpHeader::new("x-api-key", "secret")],
            ),
            "claude-test",
            &request,
            &transport,
        )
        .unwrap();

    let (endpoint, headers, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://api.anthropic.com/v1/messages");
    assert!(
        headers
            .iter()
            .any(|header| header.name() == "anthropic-version")
    );
    assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    assert_eq!(response.stop_reason, StopReason::ToolUse);
    assert_eq!(
        response.tool_calls().next().unwrap().name.as_str(),
        "weather"
    );
    let usage = response.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(20));
    assert_eq!(usage.cached_input_tokens, Some(7));
    assert_eq!(usage.cache_write_input_tokens, Some(3));
    assert_eq!(usage.reasoning_tokens, Some(2));
}

#[test]
fn anthropic_messages_streams_wire_deltas_and_reassembles_tool_use() {
    let transport = StreamingPayloadTransport::new(
        concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":8,\"output_tokens\":0}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"sunny\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"weather\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"Paris\\\"}\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":6}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        ),
        23,
    );
    let mut request = tool_request();
    request.reasoning = None;
    let mut events = RecordedStreamEvents::default();

    let response = ApiEndpoint::AnthropicMessages
        .stream_with_client_and_cancellation(
            &ResolvedApiTarget::new(
                "https://api.anthropic.com",
                vec![HttpHeader::new("x-api-key", "secret")],
            ),
            "claude-test",
            &request,
            &transport,
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(
        events.events,
        vec![ModelStreamEvent::TextDelta("sunny".into())]
    );
    assert_eq!(response.text(), "sunny");
    assert_eq!(
        response.tool_calls().next().unwrap().arguments,
        json!({"city": "Paris"})
    );
    assert_eq!(response.stop_reason, StopReason::ToolUse);
    let usage = response.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(20));
    assert_eq!(usage.output_tokens, Some(6));
    assert_eq!(usage.cached_input_tokens, Some(8));
    assert_eq!(usage.cache_write_input_tokens, Some(2));
    assert_eq!(usage.reasoning_tokens, None);
    assert_eq!(
        transport.request.lock().unwrap().as_ref().unwrap()["stream"],
        true
    );
}

#[test]
fn anthropic_messages_counts_the_frozen_input_payload() {
    let transport = CapturingTransport::new(json!({"input_tokens": 144}));
    let mut request = tool_request();
    request.reasoning = None;
    request.max_output_tokens = Some(2_048);
    request.temperature = Some(0.25);
    let target = ResolvedApiTarget::new(
        "https://api.anthropic.com",
        vec![HttpHeader::new("x-api-key", "secret")],
    );

    let count = ApiEndpoint::AnthropicMessages
        .count_input_tokens_with_client(&target, "claude-test", &request, &transport)
        .unwrap();

    let (endpoint, headers, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        endpoint,
        "https://api.anthropic.com/v1/messages/count_tokens"
    );
    assert_eq!(count.get(), 144);
    assert_eq!(body["model"], "claude-test");
    assert_eq!(body["tools"][0]["name"], "weather");
    assert_eq!(body["tool_choice"]["type"], "auto");
    assert!(body.get("max_tokens").is_none());
    assert!(body.get("temperature").is_none());
    assert!(
        headers
            .iter()
            .any(|header| { header.name().eq_ignore_ascii_case("anthropic-version") })
    );
}

#[test]
fn anthropic_prompt_cache_profile_scope_uses_the_resolved_target_and_credentials() {
    let response = json!({
        "id": "msg_1",
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_input_tokens": 6}
    });
    let first = CapturingTransport::new(response.clone());
    let second = CapturingTransport::new(response);
    let first_target = ResolvedApiTarget::new(
        "https://profile-a.example/v1",
        vec![HttpHeader::new("x-api-key", "profile-a-secret")],
    );
    let second_target = ResolvedApiTarget::new(
        "https://profile-b.example/v1",
        vec![HttpHeader::new("x-api-key", "profile-b-secret")],
    );
    let request = ModelRequest::text("stable prompt");

    let first_response = ApiEndpoint::AnthropicMessages
        .complete_with_client(&first_target, "claude-test", &request, &first)
        .unwrap();
    ApiEndpoint::AnthropicMessages
        .complete_with_client(&second_target, "claude-test", &request, &second)
        .unwrap();

    let (first_url, first_headers, first_body) = first.request.lock().unwrap().clone().unwrap();
    let (second_url, second_headers, second_body) = second.request.lock().unwrap().clone().unwrap();
    assert_ne!(first_url, second_url);
    assert_ne!(first_headers[0].value(), second_headers[0].value());
    assert_eq!(first_body, second_body);
    assert_eq!(first_response.usage.unwrap().cached_input_tokens, Some(6));
}

#[test]
fn gemini_count_tokens_encodes_the_native_generate_content_request() {
    let transport = CapturingTransport::new(json!({"totalTokens": 233}));
    let mut request = tool_request();
    request.reasoning = None;
    let target = ResolvedApiTarget::new(
        "https://generativelanguage.googleapis.com/v1beta",
        vec![HttpHeader::new("x-goog-api-client", "ash/0.1")],
    );

    let count = InputTokenCountEndpoint::GoogleGenerateContent
        .count_with_client(&target, "gemini-test", &request, &transport)
        .unwrap();

    let (endpoint, _, body) = transport.request.lock().unwrap().clone().unwrap();
    let generate = &body["generateContentRequest"];
    assert_eq!(
        endpoint,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:countTokens"
    );
    assert_eq!(count.get(), 233);
    assert_eq!(generate["model"], "models/gemini-test");
    assert_eq!(
        generate["systemInstruction"]["parts"][0]["text"],
        "Use tools when needed."
    );
    assert_eq!(generate["contents"][0]["role"], "user");
    assert_eq!(
        generate["tools"][0]["functionDeclarations"][0]["name"],
        "weather"
    );
    assert_eq!(
        generate["toolConfig"]["functionCallingConfig"]["mode"],
        "AUTO"
    );
}

#[test]
fn kimi_estimate_tokens_sends_only_the_documented_input_fields() {
    let transport = CapturingTransport::new(json!({"data": {"total_tokens": 87}}));
    let mut request = ModelRequest::text("hello");
    request.max_output_tokens = Some(512);
    request.temperature = Some(0.5);

    let count = InputTokenCountEndpoint::KimiChatCompletions
        .count_with_client(&target(), "kimi-k2.6", &request, &transport)
        .unwrap();

    let (endpoint, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        endpoint,
        "https://example.test/v1/tokenizers/estimate-token-count"
    );
    assert_eq!(count.get(), 87);
    assert_eq!(body["model"], "kimi-k2.6");
    assert_eq!(body["messages"][0]["content"], "hello");
    assert!(body.get("stream").is_none());
    assert!(body.get("max_tokens").is_none());
    assert!(body.get("temperature").is_none());
}

#[test]
fn zai_tokenizer_preserves_tools_but_removes_generation_fields() {
    let transport = CapturingTransport::new(json!({
        "usage": {
            "prompt_tokens": 120,
            "image_tokens": 24,
            "total_tokens": 144
        }
    }));
    let mut request = tool_request();
    request.reasoning = None;
    request.max_output_tokens = Some(512);

    let count = InputTokenCountEndpoint::ZaiChatCompletions
        .count_with_client(&target(), "glm-5.1", &request, &transport)
        .unwrap();

    let (endpoint, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/tokenizer");
    assert_eq!(count.get(), 144);
    assert_eq!(body["tools"][0]["function"]["name"], "weather");
    assert!(body["tools"][0]["function"].get("strict").is_none());
    assert!(body.get("tool_choice").is_none());
    assert!(body.get("max_tokens").is_none());
}

#[test]
fn endpoint_families_report_their_underlying_protocol() {
    assert_eq!(
        ApiEndpoint::OpenAiResponses.protocol(),
        ApiProtocol::OpenAiResponses
    );
    assert_eq!(
        ApiEndpoint::AnthropicMessages.protocol(),
        ApiProtocol::AnthropicMessages
    );
    assert_eq!(
        ApiEndpoint::OpenAiChatCompletions.protocol(),
        ApiProtocol::OpenAiCompletions
    );
    assert_eq!(
        ApiEndpoint::DeepSeekChatCompletions.protocol(),
        ApiProtocol::OpenAiCompletions
    );
}

#[test]
fn semantic_endpoints_restore_provider_results_to_input_order() {
    let embeddings = CapturingTransport::new(json!({
        "data": [
            {"index": 1, "embedding": [0.0, 1.0]},
            {"index": 0, "embedding": [1.0, 0.0]}
        ]
    }));
    let vectors = SemanticApiEndpoint::OpenAiCompatible
        .embed_with_client(
            &target(),
            "embed-v1",
            &["first".into(), "second".into()],
            &embeddings,
        )
        .unwrap();
    assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    let (_, headers, body) = embeddings.request.lock().unwrap().clone().unwrap();
    assert_eq!(body["input"], json!(["first", "second"]));
    assert!(headers.iter().any(|header| {
        header.name().eq_ignore_ascii_case("content-type") && header.value() == "application/json"
    }));

    let rerank = CapturingTransport::new(json!({
        "results": [
            {"index": 1, "relevance_score": 0.8},
            {"index": 0, "score": 0.2}
        ]
    }));
    let scores = SemanticApiEndpoint::OpenAiCompatible
        .rerank_with_client(
            &target(),
            "rerank-v1",
            "query",
            &["first".into(), "second".into()],
            &rerank,
        )
        .unwrap();
    assert_eq!(scores, vec![0.2, 0.8]);
}

#[test]
fn chat_completions_endpoint_dispatches_through_the_shared_codec() {
    let transport = CapturingTransport::new(json!({
        "id": "chatcmpl_1",
        "choices": [{
            "message": {"content": "compatible"},
            "finish_reason": "stop"
        }]
    }));
    let response = ApiEndpoint::OpenAiChatCompletions
        .complete_with_client(
            &target(),
            "compatible-model",
            &ModelRequest::text("hello"),
            &transport,
        )
        .unwrap();
    let (endpoint, _, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/chat/completions");
    assert_eq!(response.text(), "compatible");
}

#[test]
fn header_debug_output_redacts_credentials() {
    let debug = format!("{:?}", HttpHeader::new("Authorization", "Bearer secret"));
    assert!(debug.contains("Authorization"));
    assert!(!debug.contains("Bearer secret"));
}

#[test]
fn non_success_status_is_preserved_for_api_error_decoding() {
    let error = ApiEndpoint::OpenAiResponses
        .complete_with_client(
            &target(),
            "gpt-test",
            &ModelRequest::text("hello"),
            &StatusClient(429),
        )
        .unwrap_err();

    assert_eq!(
        error,
        ash_api::ApiError::RateLimited {
            retry_after_ms: None
        }
    );
}

#[test]
fn provider_status_and_error_bodies_map_to_semantic_failures() {
    let cases = [
        (
            401,
            r#"{"error":{"message":"Incorrect API key"}}"#,
            ash_api::ApiError::HttpStatus(401),
        ),
        (
            403,
            r#"{"error":{"status":"PERMISSION_DENIED"}}"#,
            ash_api::ApiError::HttpStatus(403),
        ),
        (
            400,
            r#"{"error":{"code":"context_length_exceeded"}}"#,
            ash_api::ApiError::ContextOverflow(
                r#"{"error":{"code":"context_length_exceeded"}}"#.into(),
            ),
        ),
        (
            400,
            r#"{"error":{"type":"invalid_request_error","message":"prompt is too long"}}"#,
            ash_api::ApiError::ContextOverflow(
                r#"{"error":{"type":"invalid_request_error","message":"prompt is too long"}}"#
                    .into(),
            ),
        ),
        (
            400,
            r#"{"error":{"status":"INVALID_ARGUMENT","message":"input token count exceeds the maximum"}}"#,
            ash_api::ApiError::ContextOverflow(
                r#"{"error":{"status":"INVALID_ARGUMENT","message":"input token count exceeds the maximum"}}"#
                    .into(),
            ),
        ),
        (
            400,
            r#"{"error":{"type":"invalid_request_error","message":"unsupported tool"}}"#,
            ash_api::ApiError::InvalidRequest(
                r#"{"error":{"type":"invalid_request_error","message":"unsupported tool"}}"#
                    .into(),
            ),
        ),
        (529, "overloaded", ash_api::ApiError::HttpStatus(529)),
    ];

    for (status, body, expected) in cases {
        let error = ApiEndpoint::OpenAiResponses
            .complete_with_client(
                &target(),
                "gpt-test",
                &ModelRequest::text("hello"),
                &ErrorResponseClient { status, body },
            )
            .unwrap_err();
        assert_eq!(error, expected);
    }
}

struct StatusClient(u16);

impl OperationClient for StatusClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Ok(ClientResponse::new(
            self.0,
            Vec::new(),
            b"rate limited".to_vec(),
        ))
    }
}

struct ErrorResponseClient {
    status: u16,
    body: &'static str,
}

impl OperationClient for ErrorResponseClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Ok(ClientResponse::new(
            self.status,
            Vec::new(),
            self.body.as_bytes().to_vec(),
        ))
    }
}
