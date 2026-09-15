use super::*;
use ash_async_utils::CancellationToken;
use std::sync::atomic::AtomicUsize;

// Existing request/credential fixtures use these wire responses for both consumption styles.
pub(super) fn response_stream(response: &Value) -> String {
    if response.get("output").is_some() {
        let mut response = response.clone();
        response["status"] = json!("completed");
        return format!(
            "event: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed", "response":response})
        );
    }
    if let Some(choices) = response.get("choices") {
        return format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"index":0, "delta":choices[0]["message"],
                "finish_reason":choices[0]["finish_reason"]}], "usage":response["usage"]})
        );
    }
    let mut message = response.clone();
    message["content"] = json!([]);
    message["stop_reason"] = Value::Null;
    let mut events = vec![json!({"type":"message_start", "message":message})];
    for (index, block) in response["content"].as_array().unwrap().iter().enumerate() {
        events.push(json!({"type":"content_block_start", "index":index, "content_block":block}));
        events.push(json!({"type":"content_block_stop", "index":index}));
    }
    events.push(json!({"type":"message_delta", "delta":{"stop_reason":response["stop_reason"]}, "usage":response["usage"]}));
    events.push(json!({"type":"message_stop"}));
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

enum StreamEnd {
    Completed,
    Truncated,
    Cancelled,
}

struct ObservedChatClient {
    finished: Arc<AtomicBool>,
    calls: AtomicUsize,
    end: StreamEnd,
}

impl OperationClient for ObservedChatClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        panic!("model generation must use the streaming operation")
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        cancellation
            .check()
            .map_err(|signal| ClientError::Cancelled(signal.reason().to_string()))?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.finished.store(false, Ordering::SeqCst);
        let body: Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(request.url().ends_with("/chat/completions"));
        sink.emit(b"data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"inspect\"},\"finish_reason\":null}]}\n\n")?;
        sink.emit(b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"live\"},\"finish_reason\":null}]}\n\n")?;
        match self.end {
            StreamEnd::Completed => {
                let tail = concat!(
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"query\\\":\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"value\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"prompt_cache_hit_tokens\":2}}\n\n",
                    "data: [DONE]\n\n",
                );
                for chunk in tail.as_bytes().chunks(23) {
                    sink.emit(chunk)?;
                }
            }
            StreamEnd::Truncated => {}
            StreamEnd::Cancelled => {
                return Err(ClientError::Cancelled("consumer cancelled".into()));
            }
        }
        self.finished.store(true, Ordering::SeqCst);
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

struct LiveEvents {
    finished: Arc<AtomicBool>,
    events: Vec<ModelStreamEvent>,
}

impl ModelEventSink for LiveEvents {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ModelProviderError> {
        assert!(
            !self.finished.load(Ordering::SeqCst),
            "delta arrived after the response finished"
        );
        self.events.push(event);
        Ok(())
    }
}

#[test]
fn every_chat_provider_delivers_live_events_and_the_same_complete_result() {
    let definitions = ProviderConfigRegistry::builtin();
    for definition in definitions
        .providers()
        .filter(|definition| definition.api_profile == ApiProfile::OpenAiChatCompletions)
    {
        let id = definition.id.as_str();
        let finished = Arc::new(AtomicBool::new(false));
        let client = Arc::new(ObservedChatClient {
            finished: finished.clone(),
            calls: AtomicUsize::new(0),
            end: StreamEnd::Completed,
        });
        let runtime = ModelProviderRuntime::builtin_with_client(client.clone());
        let config = provider_config_with_endpoint(id, format!("https://example.test/{id}/v1"));
        let name = "test-model";
        let model = runtime.build_model(&config, &model_ref(id, name)).unwrap();
        let mut events = LiveEvents {
            finished,
            events: Vec::new(),
        };
        let response = model
            .stream_with_cancellation(
                &ModelRequest::text("hello"),
                &CancellationSource::new().token(),
                &mut events,
            )
            .unwrap();
        assert_eq!(
            events.events,
            vec![
                ModelStreamEvent::ReasoningDelta("inspect".into()),
                ModelStreamEvent::TextDelta("live".into())
            ],
            "{id}"
        );
        assert_eq!(
            model.output_transport(),
            ModelOutputTransport::NativeStreaming,
            "{id}"
        );
        assert_eq!(response.text(), "live", "{id}");
        assert_eq!(response.stop_reason, StopReason::ToolUse, "{id}");
        let call = response.tool_calls().next().unwrap();
        assert_eq!(call.name.as_str(), "lookup", "{id}");
        assert_eq!(call.arguments, json!({"query":"value"}), "{id}");
        assert_eq!(
            response.usage.as_ref().unwrap().input_tokens,
            Some(7),
            "{id}"
        );
        if id == "deepseek" {
            assert_eq!(
                response.usage.as_ref().unwrap().cached_input_tokens,
                Some(2)
            );
        }
        assert_eq!(
            model.invoke(&ModelRequest::text("hello")).unwrap(),
            response,
            "{id}"
        );
        assert_eq!(
            client.calls.load(Ordering::SeqCst),
            2,
            "one request per invocation: {id}"
        );
    }
}

#[test]
fn incomplete_streams_fail_without_replaying_delivered_content() {
    for end in [StreamEnd::Truncated, StreamEnd::Cancelled] {
        let cancelled = matches!(end, StreamEnd::Cancelled);
        let client = Arc::new(ObservedChatClient {
            finished: Arc::new(AtomicBool::new(false)),
            calls: AtomicUsize::new(0),
            end,
        });
        let runtime = ModelProviderRuntime::builtin_with_client(client.clone());
        let model = runtime
            .build_model(
                &provider_config("ollama"),
                &model_ref("ollama", "test-model"),
            )
            .unwrap();
        let mut events = RecordedModelEvents::default();
        let result = model.stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut events,
        );
        if cancelled {
            assert_eq!(
                result,
                Err(ModelProviderError::Cancelled("consumer cancelled".into()))
            );
        } else {
            assert!(
                matches!(result, Err(ModelProviderError::InvalidResponse(_))),
                "{result:?}"
            );
        }
        assert_eq!(
            events.0,
            vec![
                ModelStreamEvent::ReasoningDelta("inspect".into()),
                ModelStreamEvent::TextDelta("live".into())
            ]
        );
        assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    }
}

struct RejectEvents;

impl ModelEventSink for RejectEvents {
    fn emit(&mut self, _: ModelStreamEvent) -> Result<(), ModelProviderError> {
        Err(ModelProviderError::Unavailable("receiver closed".into()))
    }
}

#[test]
fn receiver_errors_stop_the_stream_and_keep_their_original_category() {
    let client = Arc::new(ObservedChatClient {
        finished: Arc::new(AtomicBool::new(false)),
        calls: AtomicUsize::new(0),
        end: StreamEnd::Completed,
    });
    let runtime = ModelProviderRuntime::builtin_with_client(client.clone());
    let model = runtime
        .build_model(
            &provider_config("ollama"),
            &model_ref("ollama", "test-model"),
        )
        .unwrap();
    assert_eq!(
        model.stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut RejectEvents
        ),
        Err(ModelProviderError::Unavailable("receiver closed".into()))
    );
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
    assert!(!client.finished.load(Ordering::SeqCst));
}

#[test]
fn declared_unary_endpoints_complete_but_reject_stream_requests_before_sending() {
    let definition = ProviderDefinition::new(
        provider_id("unary"),
        "Unary",
        ProviderAdapter::OpenAiCompatible,
        ApiProfile::OpenAiChatCompletions,
        EndpointPolicy::ConfiguredOnly,
        ModelCatalogPolicy::AllowUnlisted,
    );
    let client = Arc::new(CapturingTransport::new(completion_response("complete")));
    let runtime = ModelProviderRuntime::with_client(
        ProviderConfigRegistry::from_definitions([definition]).unwrap(),
        client.clone(),
    );
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("unary", "https://example.test/v1"),
            &model_ref("unary", "test-model"),
        )
        .unwrap();
    let mut events = RecordedModelEvents::default();
    assert_eq!(
        model.stream_with_cancellation(
            &ModelRequest::text("hello"),
            &CancellationSource::new().token(),
            &mut events
        ),
        Err(ModelProviderError::Unavailable(
            "the configured model endpoint does not support streaming".into()
        ))
    );
    assert!(client.request.lock().unwrap().is_none());
    assert!(events.0.is_empty());
    assert_eq!(
        model.invoke(&ModelRequest::text("hello")).unwrap().text(),
        "complete"
    );
    assert_eq!(
        client.request.lock().unwrap().as_ref().unwrap().2["stream"],
        false
    );
}

#[test]
fn real_http_delivers_a_delta_while_the_server_is_waiting_to_finish() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let (mut connection, _) = listener.accept().unwrap();
        let request = read_http_request(&mut connection);
        connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
        let first = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"live\"},\"finish_reason\":null}]}\n\n";
        write!(connection, "{:x}\r\n{first}\r\n", first.len()).unwrap();
        connection.flush().unwrap();
        // The server cannot finish until the event has crossed the entire model invocation path.
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("delta was buffered until completion");
        let last = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        write!(connection, "{:x}\r\n{last}\r\n0\r\n\r\n", last.len()).unwrap();
        request
    });

    struct Notify(std::sync::mpsc::SyncSender<()>);
    impl ModelEventSink for Notify {
        fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ModelProviderError> {
            assert_eq!(event, ModelStreamEvent::TextDelta("live".into()));
            self.0
                .send(())
                .map_err(|_| ModelProviderError::Unavailable("test server stopped".into()))
        }
    }
    let runtime = ModelProviderRuntime::builtin();
    let model = runtime
        .build_model(
            &provider_config_with_endpoint("ollama", format!("http://{address}/v1")),
            &model_ref("ollama", "test-model"),
        )
        .unwrap();
    let result = model.stream_with_cancellation(
        &ModelRequest::text("hello"),
        &CancellationSource::new().token(),
        &mut Notify(sender),
    );
    let request = server.join().unwrap();
    assert_eq!(result.unwrap().text(), "live");
    assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["stream"], true);
}

#[test]
fn cancelled_model_calls_do_not_start_an_operation() {
    let client = Arc::new(ObservedChatClient {
        finished: Arc::new(AtomicBool::new(false)),
        calls: AtomicUsize::new(0),
        end: StreamEnd::Completed,
    });
    let runtime = ModelProviderRuntime::builtin_with_client(client.clone());
    let model = runtime
        .build_model(
            &provider_config("ollama"),
            &model_ref("ollama", "test-model"),
        )
        .unwrap();
    let cancellation = CancellationSource::new();
    cancellation.cancel();
    assert!(matches!(
        model.stream_with_cancellation(
            &ModelRequest::text("hello"),
            &cancellation.token(),
            &mut RecordedModelEvents::default()
        ),
        Err(ModelProviderError::Cancelled(_))
    ));
    assert!(matches!(
        model.invoke_with_cancellation(&ModelRequest::text("hello"), &cancellation.token()),
        Err(ModelProviderError::Cancelled(_))
    ));
    assert_eq!(client.calls.load(Ordering::SeqCst), 0);
}
