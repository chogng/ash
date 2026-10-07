use super::*;

#[path = "websocket_session_tests.rs"]
mod websocket_sessions;
use ash_api::{ModelRequest, ModelStreamEvent, StopReason, ToolDefinition, ToolName};
use ash_async_utils::CancellationSource;
use ash_chatgpt::ChatGptOAuth;
use ash_client::{
    ClientError, ClientRequest, ClientResponse, OperationClient, OperationStreamSink,
};
use ash_context_engine::ContextTokenMeasurementAccuracy;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_glm::{GlmOAuth, GlmProvider};
use ash_http_client::HttpHeader;
use ash_kimi::KimiCli;
use ash_kimi::KimiDesktop;
use ash_kimi::KimiOAuth;
use ash_model_tokenizer::LocalTokenCount;
use ash_model_tokenizer::LocalTokenizationOutcome;
use ash_model_tokenizer::LocalTokenizerError;
use ash_model_tokenizer::LocalTokenizerService;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use model_provider_info::{
    ApiProfile, EndpointPolicy, ModelCatalogPolicy, ModelProviderConfig, ProviderAdapter,
    ProviderConfigError, ProviderConfigRegistry, ProviderDefinition,
};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[path = "streaming_tests.rs"]
mod streaming;

#[path = "start_plan_tests.rs"]
mod start_plan;

#[path = "cache_probe_tests.rs"]
mod cache_probe;

#[path = "chatgpt_recovery_tests.rs"]
mod chatgpt_recovery;

#[test]
fn api_failure_categories_are_preserved_by_the_provider_boundary() {
    assert_eq!(
        ModelProviderError::from(ApiError::ContextOverflow("context detail".into())),
        ModelProviderError::ContextOverflow("context detail".into())
    );
    assert_eq!(
        ModelProviderError::from(ApiError::AuthFailed("auth detail".into())),
        ModelProviderError::AuthFailed("auth detail".into())
    );
    assert_eq!(
        ModelProviderError::from(ApiError::InvalidRequest("request detail".into())),
        ModelProviderError::InvalidRequest("request detail".into())
    );
    assert_eq!(
        ModelProviderError::from(ApiError::InvalidResponse("response detail".into())),
        ModelProviderError::InvalidResponse("response detail".into())
    );
}

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

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.execute(request)?;
        let body: Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(body["stream"], true);
        sink.emit(streaming::response_stream(&self.response).as_bytes())?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct FailingTransport;

impl OperationClient for FailingTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Err(ClientError::Transport(
            "fixture count endpoint failure".into(),
        ))
    }
}

struct StreamingTransport;

impl OperationClient for StreamingTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("registered Responses models must retain the streaming operation path")
    }

    fn execute_streaming(
        &self,
        _: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        let payload = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"live\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"live\"}]}]}}\n\n",
        );
        sink.emit(payload.as_bytes())?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct StreamingAnthropicTransport;

impl OperationClient for StreamingAnthropicTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("registered Anthropic models must retain the streaming operation path")
    }

    fn execute_streaming(
        &self,
        _: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        let payload = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":11,\"output_tokens\":0}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"inspect\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"live\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"lookup\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"value\\\"}\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        for chunk in payload.as_bytes().chunks(29) {
            sink.emit(chunk)?;
        }
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct TruncatedAnthropicTransport;

impl OperationClient for TruncatedAnthropicTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("truncated Anthropic stream fixture must not use unary execution")
    }

    fn execute_streaming(
        &self,
        _: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        sink.emit(
            concat!(
                "event: message_start\n",
                "data: {\"type\":\"message_start\",\"message\":{\"content\":[],\"usage\":{}}}\n\n",
            )
            .as_bytes(),
        )?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

#[derive(Default)]
struct CancellingAnthropicTransport {
    cancellable_stream_path: AtomicBool,
}

impl OperationClient for CancellingAnthropicTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("cancelled Anthropic stream fixture must not use unary execution")
    }

    fn execute_streaming_with_cancellation(
        &self,
        _: &ClientRequest,
        _: &ash_async_utils::CancellationToken,
        _: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.cancellable_stream_path.store(true, Ordering::Relaxed);
        Err(ClientError::Cancelled(
            "cancelled during Anthropic stream".into(),
        ))
    }
}

struct StreamingChatTransport;

impl OperationClient for StreamingChatTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("registered streaming Chat Completions models must not use unary execution")
    }

    fn execute_streaming(
        &self,
        _: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        let payload = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"live\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );
        for chunk in payload.as_bytes().chunks(17) {
            sink.emit(chunk)?;
        }
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

#[derive(Default)]
struct RecordedModelEvents(Vec<ModelStreamEvent>);

impl ModelEventSink for RecordedModelEvents {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ModelProviderError> {
        self.0.push(event);
        Ok(())
    }
}

fn provider_id(value: &str) -> ProviderId {
    ProviderId::new(value).unwrap()
}

fn model_id(value: &str) -> ModelId {
    ModelId::new(value).unwrap()
}

fn model_ref(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(provider_id(provider), model_id(model))
}

fn provider_config(provider: &str) -> ModelProviderConfig {
    ModelProviderConfig::for_connection(ash_protocol::ModelConnectionId::new(provider).unwrap())
}

fn provider_config_with_endpoint(
    provider: &str,
    base_url: impl Into<String>,
) -> ModelProviderConfig {
    ModelProviderConfig {
        model_acceleration: Default::default(),
        disabled_acceleration_options: Default::default(),
        connection: ash_protocol::ModelConnectionId::new(provider).unwrap(),
        custom: None,
        provider: model_provider_info::connection_provider(
            &ash_protocol::ModelConnectionId::new(provider).unwrap(),
        ),
        base_url: Some(base_url.into()),
        max_output_tokens: None,
        model_context: Default::default(),
    }
}

fn completion_response(text: &str) -> Value {
    json!({
        "id": "chatcmpl_1",
        "choices": [{
            "message": { "content": text },
            "finish_reason": "stop"
        }]
    })
}

fn responses_response(text: &str) -> Value {
    json!({
        "id": "resp_1",
        "status": "completed",
        "output": [{
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text}]
        }]
    })
}

#[test]
fn custom_provider_uses_selected_protocol_and_isolated_credentials() {
    use model_provider_info::CustomProviderConfig;
    use model_provider_info::CustomProviderProtocol;
    for (protocol, path, response) in [
        (
            CustomProviderProtocol::Responses,
            "responses",
            responses_response("responses result"),
        ),
        (
            CustomProviderProtocol::ChatCompletions,
            "chat/completions",
            completion_response("chat result"),
        ),
    ] {
        let mut config = ModelProviderConfig::new(provider_id("custom-test"));
        config.custom = Some(CustomProviderConfig {
            model_aliases: Default::default(),
            context_window: 272_000,
            order: 0,
            model: None,
            name: "My service".into(),
            protocol,
        });
        config.base_url = Some("https://custom.test/v1".into());
        let secrets = Arc::new(MemorySecretStore::default());
        let credentials = crate::ProviderCredentialService::new(
            ProviderConfigRegistry::builtin()
                .with_configs([&config])
                .unwrap(),
            secrets.clone(),
        );
        credentials
            .set_api_key(
                &ash_protocol::ModelConnectionId::new(config.provider.as_str()).unwrap(),
                b"custom-key".to_vec(),
            )
            .unwrap();
        credentials
            .set_api_key(
                &ash_protocol::ModelConnectionId::new(provider_id("openai").as_str()).unwrap(),
                b"official-key".to_vec(),
            )
            .unwrap();
        let client = Arc::new(CapturingTransport::new(response));
        let runtime = ModelProviderRuntime::with_client_and_secrets(
            ProviderConfigRegistry::builtin(),
            client.clone(),
            secrets,
        );
        let model = runtime
            .build_model(&config, &model_ref("custom-test", "test-model"))
            .unwrap();
        assert!(!invoke_text(model.as_ref(), "hello").is_empty());
        let request = client.request.lock().unwrap();
        let (url, headers, _) = request.as_ref().unwrap();
        assert_eq!(url, &format!("https://custom.test/v1/{path}"));
        assert_eq!(
            headers,
            &vec![
                HttpHeader::new("Authorization", "Bearer custom-key"),
                HttpHeader::new("Content-Type", "application/json"),
                HttpHeader::new("Accept", "text/event-stream")
            ]
        );
    }
}

fn invoke_text(model: &dyn ModelInvoker, prompt: &str) -> String {
    model.invoke(&ModelRequest::text(prompt)).unwrap().text()
}

#[test]
fn registered_model_propagates_cancellation_to_the_operation_client() {
    let transport = Arc::new(CancellationRecordingTransport::default());
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(&provider_config("openai"), &model_ref("openai", "gpt-5.6"))
        .unwrap();

    let result = model.invoke_with_cancellation(
        &ModelRequest::text("hello"),
        &CancellationSource::new().token(),
    );

    assert_eq!(
        result,
        Err(ModelProviderError::Cancelled(
            "cancelled inside operation client".into()
        ))
    );
    assert!(transport.cancellable_path.load(Ordering::Relaxed));
}

#[test]
fn registered_openai_model_propagates_wire_stream_events() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(StreamingTransport));
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai", "https://example.test/v1"),
            &model_ref("openai", "gpt-5.6"),
        )
        .unwrap();
    let mut events = RecordedModelEvents::default();

    let response = model
        .stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(events.0, vec![ModelStreamEvent::TextDelta("live".into())]);
    assert_eq!(response.text(), "live");
}

#[test]
fn registered_anthropic_model_propagates_wire_stream_events() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(StreamingAnthropicTransport));
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("anthropic", "https://example.test"),
            &model_ref("anthropic", "claude-test"),
        )
        .unwrap();
    let mut events = RecordedModelEvents::default();

    let response = model
        .stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(
        events.0,
        vec![
            ModelStreamEvent::ReasoningDelta("inspect".into()),
            ModelStreamEvent::TextDelta("live".into()),
        ]
    );
    assert_eq!(response.text(), "live");
    assert_eq!(response.usage.as_ref().unwrap().output_tokens, Some(4));
    assert_eq!(
        response.tool_calls().next().unwrap().arguments,
        json!({"query": "value"})
    );
}

#[test]
fn registered_anthropic_model_rejects_a_truncated_stream() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(TruncatedAnthropicTransport));
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("anthropic", "https://example.test"),
            &model_ref("anthropic", "claude-test"),
        )
        .unwrap();

    let result = model.stream_with_cancellation(
        &ModelRequest::text("hello"),
        &CancellationSource::new().token(),
        &mut RecordedModelEvents::default(),
    );

    assert!(matches!(
        result,
        Err(ModelProviderError::InvalidResponse(_))
    ));
}

#[test]
fn registered_anthropic_model_propagates_stream_cancellation() {
    let transport = Arc::new(CancellingAnthropicTransport::default());
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("anthropic", "https://example.test"),
            &model_ref("anthropic", "claude-test"),
        )
        .unwrap();

    let result = model.stream_with_cancellation(
        &ModelRequest::text("hello"),
        &CancellationSource::new().token(),
        &mut RecordedModelEvents::default(),
    );

    assert_eq!(
        result,
        Err(ModelProviderError::Cancelled(
            "cancelled during Anthropic stream".into()
        ))
    );
    assert!(transport.cancellable_stream_path.load(Ordering::Relaxed));
}

#[test]
fn registered_google_model_propagates_wire_stream_events() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(StreamingChatTransport));
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("google", "https://example.test/v1beta/openai"),
            &model_ref("google", "gemini-test"),
        )
        .unwrap();
    let mut events = RecordedModelEvents::default();

    let response = model
        .stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(events.0, vec![ModelStreamEvent::TextDelta("live".into())]);
    assert_eq!(response.text(), "live");
    assert_eq!(response.usage.unwrap().input_tokens, Some(7));
}

#[test]
fn registered_openai_compatible_model_propagates_wire_stream_events() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(StreamingChatTransport));
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai-compatible", "https://example.test/v1"),
            &model_ref("openai-compatible", "compatible-test"),
        )
        .unwrap();
    let mut events = RecordedModelEvents::default();

    let response = model
        .stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut events,
        )
        .unwrap();

    assert_eq!(events.0, vec![ModelStreamEvent::TextDelta("live".into())]);
    assert_eq!(response.text(), "live");
    assert_eq!(response.usage.unwrap().input_tokens, Some(7));
}

#[test]
fn image_input_policy_belongs_to_the_resolved_model_invoker() {
    use ash_protocol::ImageDetail;
    use ash_utils_image::PromptImageResizeLimits;

    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(FailingTransport));
    for (provider, model, auto, high, original) in [
        (
            "openai",
            "gpt-5.6",
            (6_000, 10_000),
            (2_048, 2_440),
            (6_000, 10_000),
        ),
        (
            "openai",
            "unlisted-test-model",
            (2_048, 2_440),
            (2_048, 2_440),
            (2_048, 2_440),
        ),
        (
            "anthropic",
            "claude-sonnet-4-20250514",
            (1_568, 1_120),
            (1_568, 1_120),
            (1_568, 1_120),
        ),
        (
            "google",
            "gemini-3.6-flash",
            (3_072, 9_216),
            (3_072, 9_216),
            (3_072, 9_216),
        ),
        (
            "openai-compatible",
            "compatible-test",
            (2_048, 1_536),
            (2_048, 1_536),
            (2_048, 1_536),
        ),
    ] {
        let config = if provider == "openai-compatible" {
            provider_config_with_endpoint(provider, "https://example.test/v1")
        } else {
            provider_config(provider)
        };
        let invoker = runtime
            .build_model(&config, &model_ref(provider, model))
            .unwrap();
        let policy = invoker.image_input_policy();
        for (detail, (dimension, patches)) in [
            (ImageDetail::Auto, auto),
            (ImageDetail::Low, (512, 256)),
            (ImageDetail::High, high),
            (ImageDetail::Original, original),
        ] {
            assert_eq!(
                match detail {
                    ImageDetail::Auto => policy.auto,
                    ImageDetail::Low => policy.low,
                    ImageDetail::High => policy.high,
                    ImageDetail::Original => policy.original,
                },
                PromptImageResizeLimits::new(dimension, patches),
                "{provider}/{model}: {detail:?}"
            );
        }
    }
}

#[test]
fn registered_models_report_their_declared_output_transport() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(FailingTransport));
    for (provider, model, expected) in [
        (
            "openai",
            "gpt-5.6",
            ash_protocol::ModelOutputTransport::NativeStreaming,
        ),
        (
            "anthropic",
            "claude-test",
            ash_protocol::ModelOutputTransport::NativeStreaming,
        ),
        (
            "google",
            "gemini-test",
            ash_protocol::ModelOutputTransport::NativeStreaming,
        ),
        (
            "openai-compatible",
            "compatible-test",
            ash_protocol::ModelOutputTransport::NativeStreaming,
        ),
        (
            "deepseek",
            "deepseek-test",
            ash_protocol::ModelOutputTransport::NativeStreaming,
        ),
    ] {
        let config = if provider == "openai-compatible" {
            provider_config_with_endpoint(provider, "https://example.test/v1")
        } else {
            provider_config(provider)
        };
        let model = runtime
            .build_model(&config, &model_ref(provider, model))
            .unwrap();
        assert_eq!(model.output_transport(), expected, "provider {provider}");
    }
}

#[test]
fn provider_and_model_ids_reject_empty_values() {
    assert_eq!(
        ProviderId::new(" ").unwrap_err().to_string(),
        "provider ID must not be empty"
    );
    assert_eq!(
        ModelId::new("").unwrap_err().to_string(),
        "model ID must not be empty"
    );
}

#[derive(Default)]
struct CancellationRecordingTransport {
    cancellable_path: AtomicBool,
}

impl OperationClient for CancellationRecordingTransport {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("registered models must use the cancellable operation path")
    }

    fn execute_streaming_with_cancellation(
        &self,
        _: &ClientRequest,
        _: &ash_async_utils::CancellationToken,
        _: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.cancellable_path.store(true, Ordering::Relaxed);
        Err(ClientError::Cancelled(
            "cancelled inside operation client".into(),
        ))
    }
}

#[test]
fn openai_runtime_uses_the_responses_adapter_and_dynamic_endpoint() {
    let transport = Arc::new(CapturingTransport::new(responses_response(
        "Hello from OpenAI",
    )));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai", " https://example.test/v1/ "),
            &model_ref("openai", "gpt-6-astra"),
        )
        .unwrap();

    let mut input = ModelRequest::text("hello");
    input.prompt_cache_key = Some("public-api-scope".into());
    assert_eq!(model.invoke(&input).unwrap().text(), "Hello from OpenAI");
    let (endpoint, headers, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/responses");
    assert!(
        headers
            .iter()
            .all(|header| header.name() != "Authorization")
    );
    assert_eq!(request["model"], "gpt-6-astra");
    assert_eq!(request["prompt_cache_key"], "public-api-scope");
    assert!(
        headers
            .iter()
            .all(|header| !header.name().eq_ignore_ascii_case("session-id"))
    );
    assert_eq!(
        request["input"][0]["content"][0]["prompt_cache_breakpoint"],
        json!({"mode":"explicit"})
    );
    assert!(request.get("temperature").is_none());
    assert!(request.get("prompt_cache_retention").is_none());
    assert_eq!(request["input"][0]["role"], "user");
    assert_eq!(request["input"][0]["content"][0]["type"], "input_text");
}

#[test]
fn direct_provider_runtime_materializes_the_stored_api_key_as_a_header() {
    let transport = Arc::new(CapturingTransport::new(responses_response("key accepted")));
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &provider_api_key_secret_key(
                &ash_protocol::ModelConnectionId::new(ProviderId::new("openai").unwrap().as_str())
                    .unwrap(),
            ),
            &SecretValue::new(b"sk-test".to_vec()),
        )
        .unwrap();
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets,
    );
    let model = runtime
        .build_model(&provider_config("openai"), &model_ref("openai", "gpt-5.6"))
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    assert_eq!(invoke_text(model.as_ref(), "hello"), "key accepted");
    let (_, headers, _) = transport.request.lock().unwrap().clone().unwrap();
    assert!(
        headers.iter().any(|header| {
            header.name() == "Authorization" && header.value() == "Bearer sk-test"
        })
    );
}

#[test]
fn direct_provider_runtime_rejects_a_missing_required_api_key() {
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        Arc::new(CapturingTransport::new(responses_response("unused"))),
        Arc::new(MemorySecretStore::default()),
    );

    let error =
        match runtime.build_model(&provider_config("openai"), &model_ref("openai", "gpt-5.6")) {
            Ok(_) => panic!("missing required API key must reject the direct provider runtime"),
            Err(error) => error,
        };

    assert!(matches!(error, ModelProviderError::Credential(message) if message.contains("openai")));
}

#[test]
fn chatgpt_subscription_runtime_uses_local_oauth_and_ash_agent_loop() {
    let transport = Arc::new(CapturingSubscriptionTransport(CapturingTransport::new(
        responses_response("Hello from ChatGPT"),
    )));
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &provider_api_key_secret_key(
                &ash_protocol::ModelConnectionId::new(provider_id("openai").as_str()).unwrap(),
            ),
            &SecretValue::new(b"openai-api-key".to_vec()),
        )
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    use base64::Engine;
    let jwt = |value: Value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    let access = jwt(json!({"exp":4_000_000_000_u64}));
    std::fs::write(home.path().join("auth.json"), serde_json::to_vec(&json!({
        "auth_mode":"chatgpt", "OPENAI_API_KEY":null,
        "tokens": {"id_token":jwt(json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1"}})), "access_token":access,"refresh_token":"never-used","account_id":"account-1"},
        "last_refresh":"2026-09-07T00:00:00Z"
    })).unwrap()).unwrap();
    let chatgpt_oauth = ChatGptOAuth::with_client(
        home.path().into(),
        secrets.clone(),
        transport.clone(),
        ash_chatgpt::ChatGptAuthManagement::Codex,
    );
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets.clone(),
    )
    .with_chatgpt_oauth(chatgpt_oauth);
    let model = runtime
        .build_model(
            &provider_config("chatgpt-subscription"),
            &model_ref("openai", "gpt-5.6-luna"),
        )
        .unwrap();

    // All ChatGPT model validation is restricted to Luna / low, including this wire fixture.
    let mut input = ModelRequest::text("hello");
    input.prompt_cache_key = Some("shared-session".into());
    input.reasoning = Some(ash_protocol::ReasoningConfig {
        effort: ash_protocol::ReasoningEffort::Low,
        summary: false,
    });
    assert_eq!(model.invoke(&input).unwrap().text(), "Hello from ChatGPT");
    let (endpoint, headers, request) = transport.0.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://chatgpt.com/backend-api/codex/responses");
    assert!(headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == format!("Bearer {access}")
    }));
    assert!(
        headers.iter().any(|header| {
            header.name() == "ChatGPT-Account-ID" && header.value() == "account-1"
        })
    );
    assert!(
        headers
            .iter()
            .any(|header| header.name() == "Originator" && header.value() == "ash")
    );
    assert_eq!(request["model"], "gpt-5.6-luna");
    assert_eq!(request["reasoning"]["effort"], "low");
    assert_eq!(request["prompt_cache_key"], "shared-session");
    let scopes = headers
        .iter()
        .filter(|header| header.name().eq_ignore_ascii_case("session-id"))
        .map(|header| header.value())
        .collect::<Vec<_>>();
    assert_eq!(scopes, vec!["shared-session"]);
    assert!(
        request["input"][0]["content"][0]
            .get("prompt_cache_breakpoint")
            .is_none()
    );
    assert_eq!(input.prompt_cache_prefix_end, Some(0));

    // Reuse this exact model instance after Codex changes the access token.
    let auth_path = home.path().join("auth.json");
    let rotated = jwt(json!({"exp":4_000_000_000_u64,"jti":"rotated"}));
    let mut auth: Value = serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
    auth["tokens"]["access_token"] = rotated.clone().into();
    std::fs::write(&auth_path, serde_json::to_vec(&auth).unwrap()).unwrap();
    let mut events = RecordedModelEvents::default();
    assert_eq!(
        model
            .stream_with_cancellation(&input, &CancellationSource::new().token(), &mut events)
            .unwrap()
            .text(),
        "Hello from ChatGPT"
    );
    let (_, headers, request) = transport.0.request.lock().unwrap().clone().unwrap();
    assert!(
        headers.iter().any(|header| header.name() == "Authorization"
            && header.value() == format!("Bearer {rotated}"))
    );
    assert_eq!(request["model"], "gpt-5.6-luna");
    assert_eq!(request["reasoning"]["effort"], "low");
    assert_eq!(request["prompt_cache_key"], "shared-session");
    let scopes = headers
        .iter()
        .filter(|header| header.name().eq_ignore_ascii_case("session-id"))
        .map(|header| header.value())
        .collect::<Vec<_>>();
    assert_eq!(scopes, vec!["shared-session"]);
    assert!(
        request["input"][0]["content"][0]
            .get("prompt_cache_breakpoint")
            .is_none()
    );
    assert_eq!(input.prompt_cache_prefix_end, Some(0));

    for scope in [Some("another-session"), None] {
        let mut other = input.clone();
        other.prompt_cache_key = scope.map(ToOwned::to_owned);
        model.invoke(&other).unwrap();
        let (_, headers, _) = transport.0.request.lock().unwrap().clone().unwrap();
        let scopes = headers
            .iter()
            .filter(|header| header.name().eq_ignore_ascii_case("session-id"))
            .map(|header| header.value())
            .collect::<Vec<_>>();
        assert_eq!(scopes, scope.into_iter().collect::<Vec<_>>());
    }

    *transport.0.request.lock().unwrap() = None;
    let disconnected = SecretKey::new("provider/openai-chatgpt/disconnected").unwrap();
    secrets
        .store(&disconnected, &SecretValue::new(b"1".to_vec()))
        .unwrap();
    assert!(matches!(
        model.invoke(&input),
        Err(ModelProviderError::Credential(_))
    ));
    assert!(secrets.load(&disconnected).unwrap().is_none());
    assert!(
        secrets
            .load(&SecretKey::new("provider/chatgpt-subscription/disconnected").unwrap())
            .unwrap()
            .is_some()
    );
    assert!(transport.0.request.lock().unwrap().is_none());
    secrets.delete(&disconnected).unwrap();
    std::fs::remove_file(auth_path).unwrap();
    assert!(matches!(
        model.stream_with_cancellation(&input, &CancellationSource::new().token(), &mut events),
        Err(ModelProviderError::Credential(_))
    ));
    assert!(transport.0.request.lock().unwrap().is_none());
}

struct CapturingSubscriptionTransport(CapturingTransport);

#[test]
#[ignore = "Real Codex subscription request: Luna / low only, read-only credentials"]
fn live_chatgpt_luna_low_uses_the_ash_model_pipeline() {
    use sha2::Digest;
    let home = ash_chatgpt::codex_home().unwrap();
    let fingerprint = || match std::fs::read(home.join("auth.json")) {
        Ok(bytes) => Some(sha2::Sha256::digest(SecretValue::new(bytes).expose())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => panic!("Codex auth.json could not be fingerprinted"),
    };
    let before = fingerprint();
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = ChatGptOAuth::with_client(
        home.clone(),
        secrets.clone(),
        Arc::new(FailingTransport),
        ash_chatgpt::ChatGptAuthManagement::Codex,
    );
    let runtime = ModelProviderRuntime::with_secrets(ProviderConfigRegistry::builtin(), secrets)
        .with_chatgpt_oauth(auth);
    // User constraint: never change this smoke test to another model or effort,
    // and never refresh or rewrite the user's Codex authentication to make it pass.
    let model = runtime
        .build_model(
            &provider_config("chatgpt-subscription"),
            &model_ref("openai", "gpt-5.6-luna"),
        )
        .unwrap();
    let mut request = ModelRequest::text(
        "Return this exact string without punctuation or extra text: ASH_AUTH_OK",
    );
    request.instructions = Some("Reply briefly. Do not use tools.".into());
    request.reasoning = Some(ash_protocol::ReasoningConfig {
        effort: ash_protocol::ReasoningEffort::Low,
        summary: false,
    });
    let mut events = RecordedModelEvents::default();
    let response =
        model.stream_with_cancellation(&request, &CancellationSource::new().token(), &mut events);
    assert!(
        before == fingerprint(),
        "Codex auth.json must remain unchanged"
    );
    if let Err(error) = &response {
        // Report only a category and event count, never provider bodies or headers.
        let category = match error {
            ModelProviderError::Api(ash_api::ApiError::Transport(message)) => {
                if message.to_ascii_lowercase().contains("timed out")
                    || message.to_ascii_lowercase().contains("timeout")
                {
                    "transport timeout"
                } else {
                    "transport"
                }
            }
            ModelProviderError::Api(
                ash_api::ApiError::UsageLimited | ash_api::ApiError::RateLimited { .. },
            ) => "usage limit",
            ModelProviderError::Api(ash_api::ApiError::Overloaded) => "service overloaded",
            ModelProviderError::AuthFailed(_) => "authentication rejected",
            ModelProviderError::Credential(_) => "credential unavailable",
            ModelProviderError::InvalidResponse(_) => "invalid response",
            ModelProviderError::InvalidRequest(_) => "invalid request",
            ModelProviderError::Cancelled(_) => "cancelled",
            _ => "other model error",
        };
        panic!(
            "Luna / low failed: {category}; delivered events: {}",
            events.0.len()
        );
    }
    assert!(
        response.unwrap().text().trim() == "ASH_AUTH_OK",
        "Luna must return the exact test marker"
    );
}

impl OperationClient for CapturingSubscriptionTransport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.0.execute(request)
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.0.execute_streaming(request, sink)
    }
}

#[test]
fn kimi_subscription_runtime_uses_local_oauth_and_the_coding_api() {
    let cache = tempfile::tempdir().unwrap();
    let transport = Arc::new(CapturingTransport::new(completion_response(
        "Hello from Kimi Code",
    )));
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &provider_api_key_secret_key(
                &ash_protocol::ModelConnectionId::new(provider_id("kimi").as_str()).unwrap(),
            ),
            &SecretValue::new(b"kimi-api-key".to_vec()),
        )
        .unwrap();
    secrets
        .store(
            &SecretKey::new("provider/kimi/current/oauth").unwrap(),
            &SecretValue::new(
                br#"{"access_token":"kimi-access","refresh_token":"kimi-refresh","token_type":"Bearer","scope":"coding","expires_at":4102444800,"device_id":"ash-device","credential_revision":3}"#.to_vec(),
            ),
        )
        .unwrap();
    let kimi_oauth = KimiOAuth::with_client(secrets.clone(), transport.clone());
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets.clone(),
    )
    .with_catalog_cache(cache.path().join("models"))
    .with_kimi_oauth(kimi_oauth);
    let model = runtime
        .build_model(
            &provider_config("kimi-subscription"),
            &model_ref("kimi", "kimi-k2.7-code"),
        )
        .unwrap();

    assert_eq!(invoke_text(model.as_ref(), "hello"), "Hello from Kimi Code");
    let (endpoint, headers, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://api.kimi.com/coding/v1/chat/completions");
    assert!(headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == "Bearer kimi-access"
    }));
    assert!(
        headers
            .iter()
            .any(|header| { header.name() == "X-Msh-Platform" && header.value() == "Ash" })
    );
    assert_eq!(request["model"], "kimi-for-coding");

    let mut fast_config = provider_config("kimi-subscription");
    fast_config.model_acceleration.insert(
        ModelId::new("kimi-k2.7-code").unwrap(),
        "model:kimi-k2.7-code-highspeed".into(),
    );
    let fast_model = runtime
        .build_model(&fast_config, &model_ref("kimi", "kimi-k2.7-code"))
        .unwrap();
    assert_eq!(
        invoke_text(fast_model.as_ref(), "hello"),
        "Hello from Kimi Code"
    );
    let (_, _, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(request["model"], "kimi-for-coding-highspeed");
    assert!(request.get("service_tier").is_none());

    let binding = runtime
        .catalog_binding(&provider_config("kimi-subscription"))
        .unwrap()
        .unwrap();
    let manager = runtime
        .models_manager_for_config(&provider_config("kimi-subscription"))
        .unwrap();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();
    let catalog = manager
        .list(
            &[binding.scope().clone()],
            &ash_models_manager::CatalogQuery::all(),
        )
        .unwrap();
    assert!(catalog.iter().any(
        |entry| entry.model() == &model_ref("kimi", "kimi-k2.7-code")
            && entry.info().access == ash_protocol::ModelAccess::Subscription
    ));
    let persisted = std::fs::read_to_string(cache.path().join("models/kimi.json")).unwrap();
    assert!(persisted.contains("kimi-k2.7-code"));
    assert!(!persisted.contains("kimi-access"));
    assert!(!persisted.contains("kimi-api-key"));

    secrets
        .store(
            &SecretKey::new("provider/kimi/current/oauth").unwrap(),
            &SecretValue::new(
                br#"{"access_token":"other-access","refresh_token":"other-refresh","token_type":"Bearer","scope":"coding","expires_at":4102444800,"device_id":"other-device","credential_revision":4}"#.to_vec(),
            ),
        )
        .unwrap();
    let changed = runtime
        .catalog_binding(&provider_config("kimi-subscription"))
        .unwrap()
        .unwrap();
    assert_ne!(binding.scope(), changed.scope());
}

#[test]
fn kimi_desktop_runtime_discovers_models_and_uses_the_desktop_gateway() {
    struct DesktopTransport {
        requests: Mutex<Vec<ClientRequest>>,
    }
    impl OperationClient for DesktopTransport {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.clone());
            let body = if request.url().ends_with("/models") {
                json!({"data":[
                    {"id":"k3-agent","display_name":"K3 Agent"},
                    {"id":"k2d8-preview","display_name":"K2 Preview"}
                ]})
            } else {
                completion_response("Hello from Kimi Desktop")
            };
            Ok(ClientResponse::new(
                200,
                Vec::new(),
                serde_json::to_vec(&body).unwrap(),
            ))
        }

        fn execute_streaming(
            &self,
            request: &ClientRequest,
            sink: &mut dyn OperationStreamSink,
        ) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.clone());
            sink.emit(
                streaming::response_stream(&completion_response("Hello from Kimi Desktop"))
                    .as_bytes(),
            )?;
            Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("config.toml");
    let content = r#"[providers.daimon-kimi-code]
type = "kimi"
base_url = "https://agent-gw.kimi.com/coding/v1"
api_key = "desktop-key"
"#;
    std::fs::write(&path, content).unwrap();
    let transport = Arc::new(DesktopTransport {
        requests: Mutex::new(Vec::new()),
    });
    let desktop = Arc::new(KimiDesktop::at(path.clone()));
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        Arc::new(MemorySecretStore::default()),
    )
    .with_catalog_cache(directory.path().join("models"))
    .with_kimi_desktop(desktop);
    let preferred = runtime
        .preferred_connections(&std::collections::BTreeMap::new())
        .unwrap();
    assert_eq!(
        preferred[&provider_id("kimi-desktop")].connection.as_str(),
        "kimi-desktop"
    );
    let config = provider_config("kimi-desktop");
    let binding = runtime.catalog_binding(&config).unwrap().unwrap();
    let manager = runtime.models_manager_for_config(&config).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();

    let model = runtime
        .build_model(&config, &model_ref("kimi-desktop", "k2d8-preview"))
        .unwrap();
    let rotated = content.replace("desktop-key", "rotated-desktop-key");
    std::fs::write(&path, &rotated).unwrap();
    assert_eq!(
        invoke_text(model.as_ref(), "hello"),
        "Hello from Kimi Desktop"
    );
    let requests = transport.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .any(|request| { request.url() == "https://agent-gw.kimi.com/coding/v1/models" })
    );
    assert!(requests.iter().any(|request| {
        request.url() == "https://agent-gw.kimi.com/coding/v1/chat/completions"
            && request.headers().iter().any(|header| {
                header.name() == "Authorization" && header.value() == "Bearer rotated-desktop-key"
            })
    }));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), rotated);
    let cached =
        std::fs::read_to_string(directory.path().join("models/kimi-desktop.json")).unwrap();
    assert!(!cached.contains("desktop-key"));
}

#[test]
fn kimi_cli_runtime_discovers_models_and_uses_the_current_cli_token() {
    struct CliTransport {
        requests: Mutex<Vec<ClientRequest>>,
    }
    impl OperationClient for CliTransport {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(ClientResponse::new(
                200,
                Vec::new(),
                serde_json::to_vec(&json!({"data":[{"id":"kimi-k2","display_name":"Kimi K2"}]}))
                    .unwrap(),
            ))
        }

        fn execute_streaming(
            &self,
            request: &ClientRequest,
            sink: &mut dyn OperationStreamSink,
        ) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.clone());
            sink.emit(
                streaming::response_stream(&completion_response("Hello from Kimi CLI")).as_bytes(),
            )?;
            Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
        }
    }

    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(directory.path().join("credentials")).unwrap();
    std::fs::write(directory.path().join("device_id"), "test-device").unwrap();
    std::fs::write(
        directory.path().join("config.toml"),
        r#"[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
"#,
    )
    .unwrap();
    let token_path = directory.path().join("credentials/kimi-code.json");
    std::fs::write(
        &token_path,
        json!({"access_token":"first-token","expires_at":4102444800u64}).to_string(),
    )
    .unwrap();
    let transport = Arc::new(CliTransport {
        requests: Mutex::new(Vec::new()),
    });
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        Arc::new(MemorySecretStore::default()),
    )
    .with_catalog_cache(directory.path().join("models"))
    .with_kimi_cli(Arc::new(KimiCli::at(directory.path().into())));
    let preferred = runtime
        .preferred_connections(&std::collections::BTreeMap::new())
        .unwrap();
    assert_eq!(
        preferred[&provider_id("kimi-cli")].connection.as_str(),
        "kimi-cli"
    );
    let config = provider_config("kimi-cli");
    let binding = runtime.catalog_binding(&config).unwrap().unwrap();
    let manager = runtime.models_manager_for_config(&config).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();
    let model = runtime
        .build_model(&config, &model_ref("kimi-cli", "kimi-k2"))
        .unwrap();
    std::fs::write(
        &token_path,
        json!({"access_token":"rotated-token","expires_at":4102444800u64}).to_string(),
    )
    .unwrap();
    assert_eq!(invoke_text(model.as_ref(), "hello"), "Hello from Kimi CLI");
    let requests = transport.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .any(|request| request.url() == "https://api.kimi.ai/coding/v1/models")
    );
    assert!(requests.iter().any(|request| {
        request.url() == "https://api.kimi.ai/coding/v1/chat/completions"
            && request.headers().iter().any(|header| {
                header.name() == "Authorization" && header.value() == "Bearer rotated-token"
            })
    }));
}

#[test]
fn openai_runtime_exposes_exact_remote_input_measurement() {
    let transport = Arc::new(CapturingTransport::new(json!({"input_tokens": 321})));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai", "https://example.test/v1"),
            &model_ref("openai", "gpt-5.6"),
        )
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("expected a provider measurement");
    };
    assert_eq!(measurement.measured_input().get(), 321);
    assert_eq!(measurement.accounted_input().get(), 321);
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Exact
    );
    let (endpoint, _, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/responses/input_tokens");
}

#[test]
fn provider_preflight_takes_priority_over_an_available_local_counter() {
    let transport = Arc::new(CapturingTransport::new(json!({"input_tokens": 321})));
    let local_tokenizers = Arc::new(FixedLocalTokenizer {
        model: model_ref("openai", "gpt-5.6"),
        tokens: 99,
    });
    let runtime = ModelProviderRuntime::builtin_with_client(transport)
        .with_local_tokenizers(local_tokenizers);
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai", "https://example.test/v1"),
            &model_ref("openai", "gpt-5.6"),
        )
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("expected the provider preflight result");
    };
    assert_eq!(measurement.measured_input().get(), 321);
    assert_eq!(
        measurement.source().kind(),
        ash_context_engine::ContextTokenMeasurementSourceKind::ProviderPreflight
    );
}

#[test]
fn provider_preflight_failure_falls_back_to_the_local_counter() {
    let local_tokenizers = Arc::new(FixedLocalTokenizer {
        model: model_ref("openai", "gpt-5.6"),
        tokens: 99,
    });
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(FailingTransport))
        .with_local_tokenizers(local_tokenizers);
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai", "https://example.test/v1"),
            &model_ref("openai", "gpt-5.6"),
        )
        .unwrap();

    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("the local tokenizer should cover provider preflight failures");
    };
    assert_eq!(measurement.measured_input().get(), 99);
    assert_eq!(
        measurement.source().kind(),
        ash_context_engine::ContextTokenMeasurementSourceKind::LocalTokenizer
    );
}

#[test]
fn model_provider_resolves_runtime_from_declarative_config() {
    let mut provider_response = completion_response("Unified runtime");
    provider_response["usage"] = json!({
        "prompt_tokens": 100,
        "prompt_cache_hit_tokens": 75,
        "prompt_cache_miss_tokens": 25,
        "completion_tokens": 10
    });
    let transport = Arc::new(CapturingTransport::new(provider_response));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model_provider: &dyn ModelProvider = &runtime;

    let model = model_provider
        .runtime(ModelRuntimeRequest::new(
            model_ref("deepseek", "deepseek-v4-pro"),
            provider_config_with_endpoint("deepseek", "https://example.test/v1"),
        ))
        .unwrap();

    let response = model.invoke(&ModelRequest::text("hello")).unwrap();
    assert_eq!(response.text(), "Unified runtime");
    assert_eq!(response.usage.unwrap().cached_input_tokens, Some(75));
    let (endpoint, _, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/chat/completions");
    assert_eq!(request["model"], "deepseek-v4-pro");
}

#[test]
fn deepseek_uses_only_an_exact_model_binding_for_local_measurement() {
    let transport = Arc::new(CapturingTransport::new(completion_response("unused")));
    let local_tokenizers = Arc::new(FixedLocalTokenizer {
        model: model_ref("deepseek", "deepseek-chat"),
        tokens: 120,
    });
    let runtime = ModelProviderRuntime::builtin_with_client(transport)
        .with_local_tokenizers(local_tokenizers);
    let bound = runtime
        .build_model(
            &provider_config("deepseek"),
            &model_ref("deepseek", "deepseek-chat"),
        )
        .unwrap();

    assert_eq!(
        bound.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Local
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        bound.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("bound DeepSeek model should use the local tokenizer");
    };
    assert_eq!(measurement.measured_input().get(), 120);
    assert_eq!(measurement.accounted_input().get(), 184);
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Estimated
    );
    assert_eq!(
        measurement.source().kind(),
        ash_context_engine::ContextTokenMeasurementSourceKind::LocalTokenizer
    );

    let unbound = runtime
        .build_model(
            &provider_config("deepseek"),
            &model_ref("deepseek", "deepseek-reasoner"),
        )
        .unwrap();
    assert_eq!(
        unbound.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Unavailable
    );
}

struct FixedLocalTokenizer {
    model: ModelRef,
    tokens: u32,
}

impl LocalTokenizerService for FixedLocalTokenizer {
    fn supports(&self, model: &ModelRef) -> bool {
        model == &self.model
    }

    fn count_input_tokens(
        &self,
        model: &ModelRef,
        _: &ModelRequest,
    ) -> Result<LocalTokenizationOutcome, LocalTokenizerError> {
        if !self.supports(model) {
            return Ok(LocalTokenizationOutcome::UnsupportedRequest);
        }
        Ok(LocalTokenizationOutcome::Count(LocalTokenCount::new(
            self.tokens,
            "fixture-tokenizer-and-template-revision",
        )?))
    }
}

#[test]
fn runtime_accepts_structured_tool_requests() {
    let transport = Arc::new(CapturingTransport::new(json!({
        "id": "resp_1",
        "status": "completed",
        "output": [{
            "type": "function_call",
            "call_id": "call_1",
            "name": "weather",
            "arguments": "{\"city\":\"Paris\"}"
        }]
    })));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let mut request = ModelRequest::text("weather");
    request.tools.push(ToolDefinition {
        name: ToolName::new("weather").expect("test tool name is valid"),
        description: "Get weather".into(),
        parameters: json!({
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": false
        }),
        strict: true,
    });
    let response = runtime
        .complete(
            &provider_config("openai"),
            &model_ref("openai", "gpt-5.6"),
            &request,
        )
        .unwrap();

    assert_eq!(response.stop_reason, StopReason::ToolUse);
    assert_eq!(
        response.tool_calls().next().unwrap().name.as_str(),
        "weather"
    );
    let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(body["tools"][0]["name"], "weather");
}

#[test]
fn openai_compatible_requires_a_configured_endpoint() {
    let runtime = ModelProviderRuntime::builtin();
    assert_eq!(
        runtime
            .instantiate(&provider_config("openai-compatible"))
            .err()
            .unwrap(),
        ModelProviderError::Config(ProviderConfigError::MissingBaseUrl(provider_id(
            "openai-compatible"
        )))
    );
}

#[test]
fn anthropic_runtime_uses_messages_shape_and_declarative_defaults() {
    let transport = Arc::new(CapturingTransport::new(json!({
        "id": "msg_1",
        "content": [
            { "type": "text", "text": "Hello" },
            { "type": "text", "text": " from Anthropic" }
        ],
        "stop_reason": "end_turn"
    })));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config("anthropic"),
            &model_ref("anthropic", "claude-test"),
        )
        .unwrap();

    assert_eq!(invoke_text(model.as_ref(), "hello"), "Hello from Anthropic");
    let (endpoint, headers, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://api.anthropic.com/v1/messages");
    assert!(
        headers
            .iter()
            .any(|header| header.name() == "anthropic-version")
    );
    assert!(headers.iter().all(|header| header.name() != "x-api-key"));
    assert_eq!(request["model"], "claude-test");
    assert_eq!(request["max_tokens"], 1024);
}

#[test]
fn anthropic_runtime_exposes_conservative_remote_input_measurement() {
    let transport = Arc::new(CapturingTransport::new(json!({"input_tokens": 10_000})));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config("anthropic"),
            &model_ref("anthropic", "claude-test"),
        )
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("expected a provider measurement");
    };
    assert_eq!(measurement.measured_input().get(), 10_000);
    assert_eq!(measurement.accounted_input().get(), 10_100);
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Estimated
    );
    let (endpoint, _, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        endpoint,
        "https://api.anthropic.com/v1/messages/count_tokens"
    );
}

#[test]
fn google_runtime_uses_native_count_tokens_as_a_conservative_measurement() {
    let transport = Arc::new(CapturingTransport::new(json!({"totalTokens": 100})));
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &provider_api_key_secret_key(
                &ash_protocol::ModelConnectionId::new(provider_id("google").as_str()).unwrap(),
            ),
            &SecretValue::new(b"google-fixture-key".to_vec()),
        )
        .unwrap();
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets,
    );
    let model = runtime
        .build_model(
            &provider_config("google"),
            &model_ref("google", "gemini-3.6-flash"),
        )
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("expected a provider measurement");
    };
    assert_eq!(measurement.measured_input().get(), 100);
    assert_eq!(measurement.accounted_input().get(), 132);
    assert_eq!(
        measurement.accuracy(),
        ContextTokenMeasurementAccuracy::Estimated
    );
    let (endpoint, headers, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        endpoint,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:countTokens"
    );
    assert!(
        headers
            .iter()
            .any(|header| header.name() == "x-goog-api-key"
                && header.value() == "google-fixture-key")
    );
    assert!(
        headers
            .iter()
            .all(|header| !header.name().eq_ignore_ascii_case("Authorization"))
    );
    assert_eq!(
        body["generateContentRequest"]["model"],
        "models/gemini-3.6-flash"
    );
}

#[test]
fn provider_measurement_capability_is_model_specific() {
    let runtime = ModelProviderRuntime::builtin();
    let google_model = runtime
        .build_model(
            &provider_config("google"),
            &model_ref("google", "unlisted-gemini-model"),
        )
        .unwrap();
    let kimi_model = runtime
        .build_model(
            &provider_config("kimi"),
            &model_ref("kimi", "unlisted-kimi-model"),
        )
        .unwrap();
    let zai_model = runtime
        .build_model(
            &provider_config("zai"),
            &model_ref("glm", "unlisted-glm-model"),
        )
        .unwrap();

    assert_eq!(
        google_model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Unavailable
    );
    assert_eq!(
        kimi_model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Unavailable
    );
    assert_eq!(
        zai_model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Unavailable
    );
}

#[test]
fn google_custom_invocation_endpoint_does_not_guess_a_native_count_url() {
    let runtime = ModelProviderRuntime::builtin();
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("google", "https://proxy.test/v1/openai"),
            &model_ref("google", "gemini-3.6-flash"),
        )
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Unavailable
    );
}

#[test]
fn kimi_runtime_exposes_the_documented_remote_estimate() {
    let transport = Arc::new(CapturingTransport::new(
        json!({"data": {"total_tokens": 200}}),
    ));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(&provider_config("kimi"), &model_ref("kimi", "kimi-k2.6"))
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("expected a provider measurement");
    };
    assert_eq!(measurement.measured_input().get(), 200);
    assert_eq!(measurement.accounted_input().get(), 232);
    let (endpoint, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        endpoint,
        "https://api.moonshot.ai/v1/tokenizers/estimate-token-count"
    );
    assert_eq!(body["messages"][0]["content"], "hello");
}

#[test]
fn zai_runtime_exposes_the_documented_remote_tokenizer() {
    let transport = Arc::new(CapturingTransport::new(
        json!({"usage": {"prompt_tokens": 300, "total_tokens": 300}}),
    ));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(&provider_config("zai"), &model_ref("glm", "glm-5.1"))
        .unwrap();

    assert_eq!(
        model.input_token_measurement_capability(),
        ContextTokenMeasurementCapability::Remote
    );
    let ContextTokenMeasurementOutcome::Measured(measurement) =
        model.measure_input(&ModelRequest::text("hello")).unwrap()
    else {
        panic!("expected a provider measurement");
    };
    assert_eq!(measurement.measured_input().get(), 300);
    assert_eq!(measurement.accounted_input().get(), 332);
    let (endpoint, _, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://api.z.ai/api/paas/v4/tokenizer");
}

#[test]
fn both_coding_plan_runtimes_measure_through_their_own_endpoints() {
    for (provider, base_url, expected_endpoint) in [
        (
            "bigmodel-coding-plan",
            model_provider_info::BIGMODEL_CODING_PLAN_BASE_URL,
            "https://open.bigmodel.cn/api/coding/paas/v4/tokenizer",
        ),
        (
            "zai-coding-plan",
            model_provider_info::ZAI_CODING_PLAN_BASE_URL,
            "https://api.z.ai/api/coding/paas/v4/tokenizer",
        ),
    ] {
        let transport = Arc::new(CapturingTransport::new(
            json!({"usage": {"prompt_tokens": 300, "total_tokens": 300}}),
        ));
        let secrets = Arc::new(MemorySecretStore::default());
        let login_provider = if provider == "bigmodel-coding-plan" {
            "bigmodel"
        } else {
            "zai"
        };
        secrets
            .store(
                &SecretKey::new(format!("provider/{login_provider}/current/oauth")).unwrap(),
                &SecretValue::new(
                    serde_json::to_vec(&json!({
                        "account_id":"account-1", "email":null, "display_name":null,
                        "model_key":"plan-key", "revision":1
                    }))
                    .unwrap(),
                ),
            )
            .unwrap();
        let runtime = ModelProviderRuntime::with_client_and_secrets(
            ProviderConfigRegistry::builtin(),
            transport.clone(),
            secrets.clone(),
        )
        .with_glm_accounts([
            GlmOAuth::with_client(GlmProvider::BigModel, secrets.clone(), transport.clone()),
            GlmOAuth::with_client(GlmProvider::Zai, secrets, transport.clone()),
        ]);
        let config = provider_config_with_endpoint(provider, base_url);
        let model = runtime
            .build_model(&config, &model_ref("glm", "glm-5.1"))
            .unwrap();

        assert_eq!(
            model.input_token_measurement_capability(),
            ContextTokenMeasurementCapability::Remote
        );
        let ContextTokenMeasurementOutcome::Measured(measurement) =
            model.measure_input(&ModelRequest::text("hello")).unwrap()
        else {
            panic!("expected a provider measurement");
        };
        assert_eq!(measurement.measured_input().get(), 300);
        let (endpoint, headers, _) = transport.request.lock().unwrap().clone().unwrap();
        assert_eq!(endpoint, expected_endpoint);
        assert!(
            headers
                .iter()
                .any(|header| header.name() == "Authorization"
                    && header.value() == "Bearer plan-key")
        );
    }
}

#[test]
fn request_output_limit_overrides_the_provider_default() {
    let transport = Arc::new(CapturingTransport::new(json!({
        "id": "msg_1",
        "content": [{ "type": "text", "text": "Compacted" }],
        "stop_reason": "end_turn"
    })));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config("anthropic"),
            &model_ref("anthropic", "claude-test"),
        )
        .unwrap();
    let mut request = ModelRequest::text("compact this context");
    request.max_output_tokens = Some(128);

    assert_eq!(model.invoke(&request).unwrap().text(), "Compacted");
    let (_, _, request) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(request["max_tokens"], 128);
}

#[test]
fn builtin_runtime_instantiates_provider_protocols() {
    let runtime = ModelProviderRuntime::builtin();
    assert_eq!(
        runtime
            .instantiate(&provider_config("openai"))
            .unwrap()
            .protocol(),
        ApiProtocol::OpenAiResponses
    );
    assert_eq!(
        runtime
            .instantiate(&provider_config("anthropic"))
            .unwrap()
            .protocol(),
        ApiProtocol::AnthropicMessages
    );
}

#[test]
fn final_image_detail_gate_uses_model_capability_not_protocol_family() {
    let openai_transport = Arc::new(CapturingTransport::new(responses_response("ok")));
    let openai_runtime = ModelProviderRuntime::builtin_with_client(openai_transport.clone());
    let openai_model = openai_runtime
        .build_model(&provider_config("openai"), &model_ref("openai", "gpt-5.6"))
        .unwrap();
    let request = request_with_original_image();
    openai_model.invoke(&request).unwrap();
    let (_, _, body) = openai_transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(body["input"][0]["content"][0]["detail"], "original");

    let custom_definition = ProviderDefinition::new(
        provider_id("custom-responses"),
        "Custom Responses",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiResponses,
        EndpointPolicy::ConfiguredOnly,
        ModelCatalogPolicy::AllowUnlisted,
    );
    let custom_transport = Arc::new(CapturingTransport::new(responses_response("ok")));
    let custom_runtime = ModelProviderRuntime::with_client(
        ProviderConfigRegistry::from_definitions([custom_definition]).unwrap(),
        custom_transport.clone(),
    );
    let custom_model = custom_runtime
        .build_model(
            &provider_config_with_endpoint("custom-responses", "https://example.test/v1"),
            &model_ref("custom-responses", "unknown-model"),
        )
        .unwrap();
    custom_model.invoke(&request).unwrap();
    let (_, _, body) = custom_transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(body["input"][0]["content"][0]["detail"], "auto");
}

fn request_with_original_image() -> ModelRequest {
    ModelRequest {
        verbosity: None,
        reasoning_summary: None,
        service_tier: None,
        speed: None,
        instructions: None,
        input: vec![ash_api::InputItem::Message(ash_api::Message {
            role: ash_api::MessageRole::User,
            content: vec![ash_api::ContentPart::ImageUrl {
                url: "data:image/png;base64,AA==".into(),
                detail: ash_api::ImageDetail::Original,
            }],
            tool_calls: Vec::new(),
        })],
        tools: Vec::new(),
        tool_choice: ash_api::ToolChoice::None,
        parallel_tool_calls: false,
        reasoning: None,
        max_output_tokens: None,
        temperature: None,
        prompt_cache_key: None,
        prompt_cache_prefix_end: Some(0),
    }
}

#[test]
fn runtime_reports_unknown_and_mismatched_providers_as_config_errors() {
    let runtime = ModelProviderRuntime::builtin();
    assert_eq!(
        runtime
            .build_model(
                &provider_config("not-registered"),
                &model_ref("not-registered", "test-model"),
            )
            .err()
            .unwrap(),
        ModelProviderError::Config(ProviderConfigError::UnknownProvider(provider_id(
            "not-registered"
        )))
    );
    assert_eq!(
        runtime
            .build_model(
                &provider_config("openai"),
                &model_ref("anthropic", "claude-test"),
            )
            .err()
            .unwrap(),
        ModelProviderError::Config(ProviderConfigError::ProviderMismatch {
            configured: provider_id("openai"),
            selected: provider_id("anthropic"),
        })
    );
}

#[test]
fn listed_catalog_rejects_unregistered_models_at_runtime() {
    let definition = ProviderDefinition::new(
        provider_id("test-provider"),
        "Test Provider",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
        EndpointPolicy::ConfiguredOnly,
        ModelCatalogPolicy::ListedOnly,
    )
    .with_models([Model::new(model_id("listed"), "Listed")]);
    let configs = ProviderConfigRegistry::from_definitions([definition]).unwrap();
    let runtime = ModelProviderRuntime::new(configs);
    let error = runtime
        .build_model(
            &provider_config_with_endpoint("test-provider", "https://example.test/v1"),
            &model_ref("test-provider", "unlisted"),
        )
        .err()
        .unwrap();

    assert_eq!(
        error,
        ModelProviderError::ModelNotRegistered {
            provider: provider_id("test-provider"),
            model: model_id("unlisted"),
        }
    );
}

#[test]
fn runtime_uses_the_declarative_api_profile_instead_of_the_adapter_name() {
    let definition = ProviderDefinition::new(
        provider_id("profile-test"),
        "Profile Test",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiResponses,
        EndpointPolicy::ConfiguredOnly,
        ModelCatalogPolicy::AllowUnlisted,
    );
    let transport = Arc::new(CapturingTransport::new(responses_response(
        "profile selected",
    )));
    let runtime = ModelProviderRuntime::with_client(
        ProviderConfigRegistry::from_definitions([definition]).unwrap(),
        transport.clone(),
    );
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("profile-test", "https://example.test/v1"),
            &model_ref("profile-test", "test-model"),
        )
        .unwrap();

    assert_eq!(invoke_text(model.as_ref(), "hello"), "profile selected");
    let (endpoint, _, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "https://example.test/v1/responses");
    assert_eq!(
        runtime
            .instantiate(&provider_config_with_endpoint(
                "profile-test",
                "https://example.test/v1",
            ))
            .unwrap()
            .protocol(),
        ApiProtocol::OpenAiResponses
    );
}

#[test]
fn google_runtime_adds_its_fixed_header() {
    let transport = Arc::new(CapturingTransport::new(completion_response("Gemini reply")));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config("google"),
            &model_ref("google", "gemini-3.6-flash"),
        )
        .unwrap();

    assert_eq!(invoke_text(model.as_ref(), "hello"), "Gemini reply");
    let (endpoint, headers, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(
        endpoint,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
    assert!(
        headers
            .iter()
            .any(|header| header.name() == "x-goog-api-client" && header.value() == "ash/0.1")
    );
}

#[test]
fn ollama_runtime_uses_its_local_default_endpoint() {
    let transport = Arc::new(CapturingTransport::new(completion_response("Ollama reply")));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let model = runtime
        .build_model(
            &provider_config("ollama"),
            &model_ref("ollama", "llama-test"),
        )
        .unwrap();

    assert_eq!(invoke_text(model.as_ref(), "hello"), "Ollama reply");
    let (endpoint, headers, _) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(endpoint, "http://localhost:11434/v1/chat/completions");
    assert_eq!(
        headers,
        vec![
            HttpHeader::new("Content-Type", "application/json"),
            HttpHeader::new("Accept", "text/event-stream")
        ]
    );
}

#[test]
fn meta_muse_uses_stored_credentials_and_streams_responses() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_http_request(&mut stream);
        let body = streaming::response_stream(&responses_response("Muse reply"));
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        request
    });
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &provider_api_key_secret_key(&ash_protocol::ModelConnectionId::new("meta").unwrap()),
            &SecretValue::new(b"meta-test-key".to_vec()),
        )
        .unwrap();
    let runtime = ModelProviderRuntime::with_secrets(ProviderConfigRegistry::builtin(), secrets);
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("meta", format!("http://{address}/v1")),
            &model_ref("meta", "muse-spark-1.3"),
        )
        .unwrap();
    let mut input = ModelRequest::text("hello");
    input.reasoning = Some(ash_protocol::ReasoningConfig {
        effort: ash_protocol::ReasoningEffort::High,
        summary: false,
    });
    assert_eq!(model.invoke(&input).unwrap().text(), "Muse reply");
    let request = server.join().unwrap();
    assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer meta-test-key")
    );
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["model"], "muse-spark-1.3");
    assert_eq!(body["reasoning"]["effort"], "high");
    assert_eq!(body["stream"], true);
}

#[test]
fn default_transport_posts_to_the_normalized_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let received = Arc::new(Mutex::new(String::new()));
    let captured_request = received.clone();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_http_request(&mut stream);
        *captured_request.lock().unwrap() = request;
        let body = streaming::response_stream(&completion_response("Provider reply"));
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let runtime = ModelProviderRuntime::builtin();
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("openai-compatible", format!("http://{address}/v1/")),
            &model_ref("openai-compatible", "test-model"),
        )
        .unwrap();

    assert_eq!(invoke_text(model.as_ref(), "hello"), "Provider reply");
    server.join().unwrap();
    let request = received.lock().unwrap();
    assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
    let header_block = request
        .split("\r\n\r\n")
        .next()
        .unwrap()
        .to_ascii_lowercase();
    assert_eq!(
        header_block
            .matches("content-type: application/json")
            .count(),
        1
    );
    assert_eq!(header_block.matches("accept: text/event-stream").count(), 1);
    assert!(!request.contains("Authorization:"));
    assert!(request.contains(r#""model":"test-model""#));
    assert!(request.contains(r#""content":"hello""#));
}

fn read_http_request(stream: &mut impl Read) -> String {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let bytes_read = stream.read(&mut buffer).unwrap();
        assert_ne!(bytes_read, 0, "request ended before its headers");
        request.extend_from_slice(&buffer[..bytes_read]);
        let Some(headers_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = std::str::from_utf8(&request[..headers_end]).unwrap();
        let content_length = headers
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .unwrap()
            .parse::<usize>()
            .unwrap();
        if request.len() >= headers_end + 4 + content_length {
            return String::from_utf8(request).unwrap();
        }
    }
}

#[test]
fn unsaved_provider_probe_uses_exact_ids_and_draft_keys_without_persisting() {
    use model_provider_info::CustomProviderConfig;
    use model_provider_info::CustomProviderProtocol;
    for (protocol, suffix, response) in [
        (
            CustomProviderProtocol::Responses,
            "responses",
            responses_response("OK"),
        ),
        (
            CustomProviderProtocol::ChatCompletions,
            "chat/completions",
            completion_response("OK"),
        ),
        (
            CustomProviderProtocol::AnthropicMessages,
            "messages",
            json!({"id":"test", "type":"message", "role":"assistant", "model":"alias", "content":[{"type":"text","text":"OK"}], "stop_reason":"end_turn", "usage":{"input_tokens":1,"output_tokens":1}}),
        ),
    ] {
        let transport = Arc::new(CapturingTransport::new(response));
        let secrets = Arc::new(MemorySecretStore::default());
        let runtime = ModelProviderRuntime::with_client_and_secrets(
            ProviderConfigRegistry::builtin(),
            transport.clone(),
            secrets.clone(),
        );
        let mut config = ModelProviderConfig::new(provider_id("custom-probe"));
        config.base_url = Some("https://example.test/gateway/v1".into());
        config.custom = Some(CustomProviderConfig {
            model_aliases: Default::default(),
            context_window: 272_000,
            order: 0,
            model: None,
            name: "Draft".into(),
            protocol,
        });
        assert_eq!(
            runtime
                .probe_connection(
                    &config,
                    Some(b"draft-key".to_vec()),
                    Some("private-model-alias")
                )
                .unwrap(),
            None
        );
        assert!(
            secrets
                .load(&crate::provider_api_key_secret_key(
                    &ash_protocol::ModelConnectionId::new(config.provider.as_str()).unwrap()
                ))
                .unwrap()
                .is_none()
        );
        let (url, headers, body) = transport.request.lock().unwrap().clone().unwrap();
        assert_eq!(url, format!("https://example.test/gateway/v1/{suffix}"));
        assert_eq!(body["model"], "private-model-alias");
        if protocol == CustomProviderProtocol::AnthropicMessages {
            assert!(
                headers
                    .iter()
                    .any(|header| header.name() == "x-api-key" && header.value() == "draft-key")
            );
            assert!(
                headers
                    .iter()
                    .any(|header| header.name() == "anthropic-version")
            );
        } else {
            assert!(
                headers.iter().any(|header| header.name() == "Authorization"
                    && header.value() == "Bearer draft-key")
            );
        }
        config.custom.as_mut().unwrap().model_aliases.insert(
            ModelId::new("private-model-alias").unwrap(),
            ModelId::new("wire-target").unwrap(),
        );
        runtime
            .probe_connection(
                &config,
                Some(b"draft-key".to_vec()),
                Some("private-model-alias"),
            )
            .unwrap();
        assert_eq!(
            transport.request.lock().unwrap().as_ref().unwrap().2["model"],
            "wire-target"
        );
    }
}

#[test]
fn every_builtin_provider_applies_its_authentication_without_subscription_headers() {
    struct Capture(Mutex<Option<ClientRequest>>);
    impl OperationClient for Capture {
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
    let providers = [
        "openai",
        "openai-compatible",
        "google",
        "xai",
        "kimi",
        "deepseek",
        "ollama",
        "bigmodel",
        "bigmodel-coding-plan",
        "zai",
        "zai-coding-plan",
        "anthropic",
        "meta",
    ];
    assert_eq!(
        providers.len(),
        ProviderConfigRegistry::builtin()
            .connections()
            .into_iter()
            // Start Plan authenticates only after its entitlement and verification checks;
            // those requests are covered by the complete Start Plan transport tests.
            .filter(|connection| !matches!(
                connection.id.as_str(),
                "bigmodel-start-plan" | "zai-start-plan"
            ))
            .filter(|connection| !matches!(
                connection.runtime,
                model_provider_info::ModelConnectionRuntime::ChatGptSubscription
                    | model_provider_info::ModelConnectionRuntime::ChatGptPlan
                    | model_provider_info::ModelConnectionRuntime::KimiCode
                    | model_provider_info::ModelConnectionRuntime::KimiDesktop
                    | model_provider_info::ModelConnectionRuntime::KimiCli
                    | model_provider_info::ModelConnectionRuntime::XaiSubscription
            ))
            .count()
    );
    for provider in providers {
        let capture = Arc::new(Capture(Mutex::new(None)));
        let secrets = Arc::new(MemorySecretStore::default());
        let key = format!("{provider}-fixture-key");
        if matches!(provider, "bigmodel-coding-plan" | "zai-coding-plan") {
            let login_provider = if provider == "bigmodel-coding-plan" {
                "bigmodel"
            } else {
                "zai"
            };
            secrets
                .store(
                    &SecretKey::new(format!("provider/{login_provider}/current/oauth")).unwrap(),
                    &SecretValue::new(
                        serde_json::to_vec(&json!({
                            "account_id":"account-1", "email":null, "display_name":null,
                            "model_key":key, "revision":1
                        }))
                        .unwrap(),
                    ),
                )
                .unwrap();
        } else {
            secrets
                .store(
                    &provider_api_key_secret_key(
                        &ash_protocol::ModelConnectionId::new(provider_id(provider).as_str())
                            .unwrap(),
                    ),
                    &SecretValue::new(key.clone().into_bytes()),
                )
                .unwrap();
        }
        let runtime = ModelProviderRuntime::with_client_and_secrets(
            ProviderConfigRegistry::builtin(),
            capture.clone(),
            secrets.clone(),
        )
        .with_glm_accounts([
            GlmOAuth::with_client(GlmProvider::BigModel, secrets.clone(), capture.clone()),
            GlmOAuth::with_client(GlmProvider::Zai, secrets, capture.clone()),
        ]);
        let model = runtime
            .build_model(
                &provider_config_with_endpoint(provider, "https://example.test/v1"),
                &ModelRef::new(
                    model_provider_info::connection_provider(
                        &ash_protocol::ModelConnectionId::new(provider).unwrap(),
                    ),
                    model_id("fixture-model"),
                ),
            )
            .unwrap();
        let mut request = ModelRequest::text("input");
        request.prompt_cache_key = Some("cache-scope".into());
        assert!(model.invoke(&request).is_err());
        let captured = capture
            .0
            .lock()
            .unwrap()
            .clone()
            .expect("provider must reach its transport");
        let headers = captured.headers();
        let values = |name: &str| {
            headers
                .iter()
                .filter(|header| header.name().eq_ignore_ascii_case(name))
                .map(|header| header.value())
                .collect::<Vec<_>>()
        };
        let bearer = format!("Bearer {key}");
        assert_eq!(
            values("Authorization"),
            if matches!(provider, "ollama" | "anthropic") {
                vec![]
            } else {
                vec![bearer.as_str()]
            },
            "{provider}"
        );
        assert_eq!(
            values("x-api-key"),
            if provider == "anthropic" {
                vec![key.as_str()]
            } else {
                vec![]
            },
            "{provider}"
        );
        assert!(
            values("x-goog-api-key").is_empty(),
            "generation must not inherit Google countTokens authentication"
        );
        assert!(
            values("session-id").is_empty(),
            "subscription context leaked into {provider}"
        );
        assert!(
            values("x-grok-conv-id").is_empty(),
            "subscription routing leaked into {provider}"
        );
        assert_eq!(values("Content-Type"), vec!["application/json"]);
        assert_eq!(values("Accept"), vec!["text/event-stream"]);
        assert_eq!(
            values("anthropic-version"),
            if provider == "anthropic" {
                vec!["2023-06-01"]
            } else {
                vec![]
            }
        );
    }
}

#[test]
fn fast_model_preference_reaches_openai_requests_and_off_selects_standard() {
    let transport = Arc::new(CapturingTransport::new(responses_response("ok")));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    for enabled in [true, false] {
        let mut config = provider_config("openai");
        if enabled {
            config
                .model_acceleration
                .insert(ModelId::new("gpt-6-astra").unwrap(), "priority".into());
        }
        let model = runtime
            .build_model(&config, &model_ref("openai", "gpt-6-astra"))
            .unwrap();
        model.invoke(&ModelRequest::text("hello")).unwrap();
        let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
        assert_eq!(
            body["service_tier"],
            if enabled { "priority" } else { "default" }
        );
    }
}

#[test]
fn fast_mode_reaches_other_provider_requests_and_off_restores_standard_inference() {
    for (provider, id) in [
        ("anthropic", "claude-opus-5-5"),
        ("anthropic", "claude-opus-4-8"),
        ("anthropic", "claude-opus-4-7"),
        ("anthropic", "claude-opus-4-6"),
        ("anthropic", "claude-sonnet-4-6"),
        ("anthropic", "claude-haiku-4-5-20251001"),
        ("google", "gemini-3.8-flash"),
        ("xai", "grok-4.7"),
    ] {
        let response = match provider {
            "anthropic" => {
                json!({"content":[{"type":"text","text":"ok"}], "stop_reason":"end_turn", "usage":{"input_tokens":1,"output_tokens":1}})
            }
            "xai" => responses_response("ok"),
            _ => completion_response("ok"),
        };
        let transport = Arc::new(CapturingTransport::new(response));
        let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
        for enabled in [true, false] {
            let mut config = provider_config(provider);
            if enabled {
                config.model_acceleration.insert(
                    ModelId::new(id).unwrap(),
                    model_provider_info::find_static_model(&model_ref(provider, id))
                        .unwrap()
                        .model()
                        .settings
                        .acceleration
                        .unwrap()
                        .id(),
                );
            }
            let model = runtime
                .build_model(&config, &model_ref(provider, id))
                .unwrap();
            assert_eq!(invoke_text(model.as_ref(), "hello"), "ok");
            let (_, headers, body) = transport.request.lock().unwrap().clone().unwrap();
            match provider {
                "anthropic" => {
                    let speed = enabled && matches!(id, "claude-opus-5-5" | "claude-opus-4-8");
                    assert_eq!(body.get("speed"), speed.then_some(&json!("fast")));
                    assert_eq!(
                        headers
                            .iter()
                            .any(|header| header.name() == "anthropic-beta"
                                && header.value() == "fast-mode-2026-02-01"),
                        speed
                    );
                    assert_eq!(
                        body["service_tier"],
                        if enabled && !speed {
                            "auto"
                        } else {
                            "standard_only"
                        }
                    );
                }
                "google" | "xai" => assert_eq!(
                    body["service_tier"],
                    if enabled { "priority" } else { "default" }
                ),
                _ => unreachable!(),
            }
        }
    }
}

#[test]
fn model_settings_are_applied_to_the_real_request_and_user_values_take_precedence() {
    let mut response = responses_response("ok");
    response["input_tokens"] = json!(321);
    let transport = Arc::new(CapturingTransport::new(response));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let selected = model_ref("openai", "gpt-6.1-sol");
    let mut info = model_provider_info::find_static_model(&selected)
        .unwrap()
        .model();
    info.capabilities.parallel_tool_calls = CapabilitySupport::Unsupported;
    info.settings.tool_output_limit = Some(ash_protocol::ModelToolOutputLimit::Bytes(180));
    let model = runtime
        .runtime(ModelRuntimeRequest::new(selected, provider_config("openai")).with_info(info))
        .unwrap();
    let mut request = ModelRequest::text("inspect the output");
    request.tools.push(ToolDefinition {
        name: ToolName::new("read").unwrap(),
        description: "Read".into(),
        parameters: json!({"type":"object","properties":{},"required":[],"additionalProperties":false}),
        strict: true,
    });
    request.input.push(ash_protocol::InputItem::ToolResult(
        ash_protocol::ToolResult {
            call_id: ash_protocol::ToolCallId::new("read-1").unwrap(),
            name: ToolName::new("read").unwrap(),
            content: vec![
                ash_protocol::ContentPart::Text("head".repeat(100)),
                ash_protocol::ContentPart::Text("tail".repeat(100)),
            ],
            is_error: false,
        },
    ));
    model.invoke(&request).unwrap();
    let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(body["text"]["verbosity"], "low");
    assert_eq!(body["parallel_tool_calls"], false);
    assert!(body.get("reasoning").is_none());
    let output_parts = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .unwrap()["output"]
        .as_array()
        .unwrap();
    assert_eq!(output_parts.len(), 1);
    let output = output_parts[0]["text"].as_str().unwrap();
    assert!(output.len() <= 180);
    assert!(output.contains("truncated"));
    assert!(matches!(
        model.measure_input(&request).unwrap(),
        ContextTokenMeasurementOutcome::Measured(_)
    ));
    let (endpoint, _, counted) = transport.request.lock().unwrap().clone().unwrap();
    assert!(endpoint.ends_with("/responses/input_tokens"));
    assert_eq!(counted["input"][1]["output"], body["input"][1]["output"]);
    assert_eq!(counted["parallel_tool_calls"], false);
    assert_eq!(counted["text"], body["text"]);
    if let ash_protocol::InputItem::ToolResult(result) = &request.input[1] {
        assert_eq!(result.content.len(), 2);
    } else {
        panic!("original result must be retained");
    }
    request.verbosity = Some(ash_protocol::ModelVerbosity::High);
    request.reasoning_summary = Some(ash_protocol::ModelReasoningSummary::Detailed);
    request.service_tier = Some("priority".into());
    model.invoke(&request).unwrap();
    let (_, _, body) = transport.request.lock().unwrap().clone().unwrap();
    assert_eq!(body["text"]["verbosity"], "high");
    assert_eq!(body["reasoning"]["summary"], "detailed");
    assert_eq!(body["service_tier"], "priority");
}

#[test]
fn known_input_modalities_reject_an_unsupported_attachment_before_transport() {
    let transport = Arc::new(CapturingTransport::new(responses_response("ok")));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let selected = model_ref("openai", "gpt-6.1-sol");
    let mut info = model_provider_info::find_static_model(&selected)
        .unwrap()
        .model();
    info.settings.input_modalities = Some(vec![ash_protocol::ModelInputModality::Text]);
    let model = runtime
        .runtime(ModelRuntimeRequest::new(selected, provider_config("openai")).with_info(info))
        .unwrap();
    assert!(matches!(
        model.invoke(&request_with_original_image()),
        Err(ModelProviderError::InvalidRequest(_))
    ));
    assert!(transport.request.lock().unwrap().is_none());
}

#[test]
fn catalog_tier_ids_drive_acceleration_and_explicit_choices_override_the_preference() {
    let transport = Arc::new(CapturingTransport::new(responses_response("ok")));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let selected = model_ref("openai", "gpt-6.1-sol");
    let mut info = model_provider_info::find_static_model(&selected)
        .unwrap()
        .model();
    info.settings
        .service_tiers
        .as_mut()
        .unwrap()
        .push(ash_protocol::ModelServiceTier {
            id: "flex".into(),
            name: "Flex".into(),
            description: "Flexible processing".into(),
        });
    info.settings.acceleration = Some(ash_protocol::ModelAcceleration::ServiceTier {
        service_tier: "flex".into(),
    });
    let mut config = provider_config("openai");
    config
        .model_acceleration
        .insert(selected.model.clone(), "flex".into());
    let model = runtime
        .runtime(ModelRuntimeRequest::new(selected, config).with_info(info))
        .unwrap();
    let mut request = ModelRequest::text("hello");
    model.invoke(&request).unwrap();
    assert_eq!(
        transport.request.lock().unwrap().as_ref().unwrap().2["service_tier"],
        "flex"
    );
    request.service_tier = Some("default".into());
    model.invoke(&request).unwrap();
    assert_eq!(
        transport.request.lock().unwrap().as_ref().unwrap().2["service_tier"],
        "default"
    );
    transport.request.lock().unwrap().take();
    request.service_tier = Some("undeclared".into());
    assert!(matches!(
        model.invoke(&request),
        Err(ModelProviderError::InvalidRequest(_))
    ));
    assert!(transport.request.lock().unwrap().is_none());
}

#[test]
fn explicit_standard_tier_disables_stored_speed_and_speed_requires_model_support() {
    let transport = Arc::new(CapturingTransport::new(
        json!({"content":[{"type":"text","text":"ok"}], "stop_reason":"end_turn", "usage":{"input_tokens":1,"output_tokens":1}}),
    ));
    let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
    let mut config = provider_config("anthropic");
    config.model_acceleration.insert(
        ModelId::new("claude-opus-5-5").unwrap(),
        "speed:fast".into(),
    );
    let model = runtime
        .build_model(&config, &model_ref("anthropic", "claude-opus-5-5"))
        .unwrap();
    let mut request = ModelRequest::text("hello");
    request.service_tier = Some("standard_only".into());
    model.invoke(&request).unwrap();
    let (_, headers, body) = transport.request.lock().unwrap().take().unwrap();
    assert!(body.get("speed").is_none());
    assert!(
        headers
            .iter()
            .all(|header| header.name() != "anthropic-beta")
    );
    request.speed = Some(ash_protocol::ModelSpeed::Fast);
    request.service_tier = None;
    model.invoke(&request).unwrap();
    let (_, _, body) = transport.request.lock().unwrap().take().unwrap();
    assert_eq!(body["speed"], "fast");
    assert_eq!(body["service_tier"], "standard_only");
    let model = runtime
        .build_model(
            &provider_config("anthropic"),
            &model_ref("anthropic", "claude-sonnet-4-6"),
        )
        .unwrap();
    assert!(matches!(
        model.invoke(&request),
        Err(ModelProviderError::InvalidRequest(_))
    ));
    assert!(transport.request.lock().unwrap().is_none());
}

#[test]
fn acceleration_options_are_admitted_independently_before_http_requests() {
    let selected = model_ref("openai", "gpt-6.1-sol");
    let mut info = model_provider_info::find_static_model(&selected)
        .unwrap()
        .model();
    info.settings
        .service_tiers
        .as_mut()
        .unwrap()
        .push(ash_protocol::ModelServiceTier {
            id: "ultrafast".into(),
            name: "Ultra Fast".into(),
            description: "Fastest processing".into(),
        });
    for disabled in [
        vec![],
        vec!["priority"],
        vec!["ultrafast"],
        vec!["priority", "ultrafast"],
    ] {
        for option in ["priority", "ultrafast"] {
            for stored in [false, true] {
                let transport = Arc::new(CapturingTransport::new(responses_response("ok")));
                let runtime = ModelProviderRuntime::builtin_with_client(transport.clone());
                let mut config = provider_config("openai");
                config.disabled_acceleration_options.insert(
                    selected.model.clone(),
                    disabled.iter().map(|id| (*id).to_owned()).collect(),
                );
                let mut request = ModelRequest::text("hello");
                if stored {
                    config
                        .model_acceleration
                        .insert(selected.model.clone(), option.into());
                } else {
                    request.service_tier = Some(option.into());
                }
                let model = runtime
                    .runtime(
                        ModelRuntimeRequest::new(selected.clone(), config).with_info(info.clone()),
                    )
                    .unwrap();
                let result = model.invoke(&request);
                if disabled.contains(&option) {
                    assert!(
                        matches!(result, Err(ModelProviderError::InvalidRequest(_))),
                        "{disabled:?}/{option}/{stored}"
                    );
                    assert!(transport.request.lock().unwrap().is_none());
                } else {
                    result.unwrap();
                    assert_eq!(
                        transport.request.lock().unwrap().as_ref().unwrap().2["service_tier"],
                        option
                    );
                }
            }
        }
    }
}

struct SpeedTransport {
    bundle: Mutex<Value>,
    models: CapturingSubscriptionTransport,
}

impl OperationClient for SpeedTransport {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        if request.url().ends_with("/config/bundle") {
            return Ok(ClientResponse::new(
                200,
                Vec::new(),
                serde_json::to_vec(&*self.bundle.lock().unwrap()).unwrap(),
            ));
        }
        if request.url().contains("/codex/models?") {
            return Ok(ClientResponse::new(
                200,
                Vec::new(),
                serde_json::to_vec(&json!({"models":[{"slug":"gpt-6-astra","visibility":"list"}]}))
                    .unwrap(),
            ));
        }
        self.models.execute(request)
    }
    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.models.execute_streaming(request, sink)
    }
}

fn speed_credentials(home: &std::path::Path, plan: &str) {
    use base64::Engine;
    let jwt = |value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    std::fs::write(home.join("auth.json"), serde_json::to_vec(&json!({"auth_mode":"chatgpt","tokens":{
        "id_token":jwt(json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1","chatgpt_plan_type":plan}})),
        "access_token":jwt(json!({"exp":4_000_000_000_u64})),"refresh_token":"unused","account_id":"account-1"
    }})).unwrap()).unwrap();
}

struct ChatGptSpeedFixture {
    home: tempfile::TempDir,
    auth: Arc<ChatGptOAuth>,
    runtime: ModelProviderRuntime,
    transport: Arc<SpeedTransport>,
}

fn chatgpt_speed_fixture(plan: &str, ultrafast: bool) -> ChatGptSpeedFixture {
    let home = tempfile::tempdir().unwrap();
    speed_credentials(home.path(), plan);
    let transport = Arc::new(SpeedTransport {
        bundle: Mutex::new(
            json!({"requirements_toml":{"enterprise_managed":[{"id":"speed-permission","name":"speed-permission","contents":format!("[features]\nultrafast_mode={ultrafast}")}]}}),
        ),
        models: CapturingSubscriptionTransport(CapturingTransport::new(responses_response("ok"))),
    });
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = ChatGptOAuth::with_client(
        home.path().into(),
        secrets.clone(),
        transport.clone(),
        ash_chatgpt::ChatGptAuthManagement::Codex,
    );
    auth.refresh_speed_access(&CancellationSource::new().token())
        .unwrap();
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        transport.clone(),
        secrets,
    )
    .with_chatgpt_oauth(auth.clone());
    ChatGptSpeedFixture {
        home,
        auth,
        runtime,
        transport,
    }
}

#[test]
fn astra_ultrafast_subscription_choices_and_http_calls_follow_the_current_plan_and_permission() {
    let astra = model_ref("openai", "gpt-6-astra");
    let config = provider_config("chatgpt-subscription");
    let info = model_provider_info::find_static_model(&astra)
        .unwrap()
        .model();
    for (plan, granted, allowed) in [
        ("plus", true, false),
        ("prolite", true, false),
        ("pro", true, false),
        ("promax", true, true),
        ("promax", false, false),
        ("business", true, false),
        ("enterprise", true, true),
        ("enterprise", false, false),
        ("edu", true, true),
        ("edu", false, false),
    ] {
        let fixture = chatgpt_speed_fixture(plan, granted);
        let choices = fixture
            .runtime
            .acceleration_options(&config, &info)
            .unwrap();
        assert_eq!(
            choices.iter().any(|option| option.id == "ultrafast"),
            allowed,
            "{plan}/{granted}"
        );
        let other = model_provider_info::find_static_model(&model_ref("openai", "gpt-6-sol"))
            .unwrap()
            .model();
        assert!(
            !fixture
                .runtime
                .acceleration_options(&config, &other)
                .unwrap()
                .iter()
                .any(|option| option.id == "ultrafast")
        );
        for stored in [false, true] {
            let mut config = config.clone();
            let mut request = ModelRequest::text("hello");
            if stored {
                config
                    .model_acceleration
                    .insert(astra.model.clone(), "ultrafast".into());
            } else {
                request.service_tier = Some("ultrafast".into());
            }
            let model = fixture.runtime.build_model(&config, &astra).unwrap();
            let result = model.invoke(&request);
            if allowed {
                result.unwrap();
                assert_eq!(
                    fixture
                        .transport
                        .models
                        .0
                        .request
                        .lock()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .2["service_tier"],
                    "ultrafast"
                );
            } else {
                assert!(
                    matches!(result, Err(ModelProviderError::InvalidRequest(_))),
                    "{plan}/{granted}/{stored}"
                );
                assert!(fixture.transport.models.0.request.lock().unwrap().is_none());
            }
        }
    }
}

#[test]
fn astra_ultrafast_revocation_rejects_an_already_bound_runtime_and_api_keys_use_api_capability() {
    let fixture = chatgpt_speed_fixture("promax", true);
    let astra = model_ref("openai", "gpt-6-astra");
    let mut config = provider_config("chatgpt-subscription");
    config
        .model_acceleration
        .insert(astra.model.clone(), "ultrafast".into());
    let model = fixture.runtime.build_model(&config, &astra).unwrap();
    *fixture.transport.bundle.lock().unwrap() = json!({"requirements_toml":{"enterprise_managed":[{"id":"revoked","name":"revoked","contents":"[features]\nultrafast_mode=false"}]}});
    fixture
        .auth
        .refresh_speed_access(&CancellationSource::new().token())
        .unwrap();
    assert!(matches!(
        model.invoke(&ModelRequest::text("hello")),
        Err(ModelProviderError::InvalidRequest(_))
    ));
    speed_credentials(fixture.home.path(), "pro");
    assert!(matches!(
        model.invoke(&ModelRequest::text("hello")),
        Err(ModelProviderError::InvalidRequest(_))
    ));
    assert!(fixture.transport.models.0.request.lock().unwrap().is_none());
    let api = provider_config("openai");
    let info = model_provider_info::find_static_model(&astra)
        .unwrap()
        .model();
    assert!(
        fixture
            .runtime
            .acceleration_options(&api, &info)
            .unwrap()
            .iter()
            .any(|option| option.id == "ultrafast")
    );
    let api_transport = Arc::new(CapturingTransport::new(responses_response("ok")));
    let api_runtime = ModelProviderRuntime::builtin_with_client(api_transport.clone());
    let mut request = ModelRequest::text("hello");
    request.service_tier = Some("ultrafast".into());
    api_runtime
        .build_model(&api, &astra)
        .unwrap()
        .invoke(&request)
        .unwrap();
    assert_eq!(
        api_transport.request.lock().unwrap().as_ref().unwrap().2["service_tier"],
        "ultrafast"
    );
}

#[test]
fn astra_ultrafast_catalog_refresh_observes_revocation_and_isolates_plan_scopes() {
    let fixture = chatgpt_speed_fixture("promax", true);
    let astra = model_ref("openai", "gpt-6-astra");
    let config = provider_config("chatgpt-subscription");
    let binding = fixture.runtime.catalog_binding(&config).unwrap().unwrap();
    let manager = fixture.runtime.models_manager_for_config(&config).unwrap();
    let executor = tokio::runtime::Runtime::new().unwrap();
    *fixture.transport.bundle.lock().unwrap() = json!({"requirements_toml":{"enterprise_managed":[{
        "id":"revoked","name":"revoked","contents":"[features]\nultrafast_mode=false"
    }]}});
    executor
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();
    assert_eq!(fixture.auth.speed_access().unwrap().ultrafast, Some(false));
    let info = manager
        .list(
            &[binding.scope().clone()],
            &ash_models_manager::CatalogQuery::all(),
        )
        .unwrap()
        .into_iter()
        .find(|entry| entry.model() == &astra)
        .unwrap()
        .info()
        .clone();
    assert_eq!(
        fixture
            .runtime
            .acceleration_options(&config, &info)
            .unwrap()
            .iter()
            .map(|option| option.id.as_str())
            .collect::<Vec<_>>(),
        vec!["priority"]
    );
    speed_credentials(fixture.home.path(), "pro");
    let changed = fixture.runtime.catalog_binding(&config).unwrap().unwrap();
    assert_ne!(binding.scope(), changed.scope());
    assert!(
        executor
            .block_on(manager.refresh(binding.scope().clone(), binding.source()))
            .is_err()
    );
    assert_eq!(fixture.auth.speed_access().unwrap().ultrafast, Some(false));
}
