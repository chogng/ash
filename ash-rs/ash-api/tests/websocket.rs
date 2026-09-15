use ash_api::*;
use ash_async_utils::CancellationSource;
use ash_client::ResolvedApiTarget;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_websocket_client::WebSocketConnector;
use futures::SinkExt;
use futures::StreamExt;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as WireMessage;

type Server = WebSocketStream<TcpStream>;
fn connector() -> WebSocketConnector {
    WebSocketConnector::new(
        OutboundNetworkSnapshot::new(
            HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        )
        .unwrap(),
    )
}
fn limits() -> WebSocketSessionConfig {
    WebSocketSessionConfig {
        idle_timeout: Duration::from_secs(3),
        max_event_bytes: 128 * 1024,
    }
}
async fn read(socket: &mut Server) -> Value {
    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
}
async fn send(socket: &mut Server, value: Value) {
    socket
        .send(WireMessage::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn completed(socket: &mut Server, id: &str, text: &str) {
    send(
        socket,
        json!({"type":"response.created","response":{"id":id}}),
    )
    .await;
    send(
        socket,
        json!({"type":"response.output_text.delta","response_id":id,"delta":text}),
    )
    .await;
    send(socket, json!({"type":"response.completed","response":{"id":id,"status":"completed","output":[{"type":"message","id":"msg-output","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}],"usage":{"input_tokens":100,"output_tokens":1,"input_tokens_details":{"cached_tokens":80}}}})).await;
}
#[derive(Default)]
struct Events(Vec<ModelStreamEvent>);
impl ApiStreamSink for Events {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ApiError> {
        self.0.push(event);
        Ok(())
    }
}

#[tokio::test]
async fn responses_reuses_exact_history_but_restarts_after_rollback_or_changed_settings() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = ResolvedApiTarget::new(
        format!("http://{}/v1", listener.local_addr().unwrap()),
        vec![HttpHeader::new("Authorization", "Bearer fixture")],
    );
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            tcp,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(request.uri().path(), "/v1/responses");
                assert_eq!(request.headers()["session-id"], "scope");
                assert_eq!(request.headers()["authorization"], "Bearer fixture");
                assert!(request.headers().get("accept").is_none());
                Ok(response)
            },
        )
        .await
        .unwrap();
        let first = read(&mut socket).await;
        assert_eq!(first["type"], "response.create");
        assert!(first.get("stream").is_none());
        assert!(first.get("previous_response_id").is_none());
        assert!(
            first["input"][0]["content"][0]
                .get("prompt_cache_breakpoint")
                .is_none()
        );
        completed(&mut socket, "r1", "first").await;
        let second = read(&mut socket).await;
        assert_eq!(second["previous_response_id"], "r1");
        assert_eq!(second["input"].as_array().unwrap().len(), 1);
        completed(&mut socket, "r2", "second").await;
        let rollback = read(&mut socket).await;
        assert!(rollback.get("previous_response_id").is_none());
        assert_eq!(rollback["input"].as_array().unwrap().len(), 2);
        completed(&mut socket, "r3", "fork").await;
        let changed = read(&mut socket).await;
        assert!(changed.get("previous_response_id").is_none());
        completed(&mut socket, "r4", "changed").await;
        assert!(socket.next().await.unwrap().unwrap().is_close());
    });
    let cancel = CancellationSource::new().token();
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::ChatGptResponses,
        "gpt-5.6-luna",
        Some("scope".into()),
        limits(),
        &cancel,
    )
    .await
    .unwrap();
    let mut request = ModelRequest::text("root");
    request.prompt_cache_key = Some("scope".into());
    let original = request.clone();
    let mut events = Events::default();
    let response = session
        .invoke(&request, &cancel, &mut events)
        .await
        .unwrap();
    assert_eq!(response.text(), "first");
    assert_eq!(response.usage.unwrap().cached_input_tokens, Some(80));
    request.input.extend([
        InputItem::Message(Message::text(MessageRole::Assistant, "first")),
        InputItem::Message(Message::text(MessageRole::User, "next")),
    ]);
    assert_eq!(
        session
            .invoke(&request, &cancel, &mut events)
            .await
            .unwrap()
            .text(),
        "second"
    );
    request = original;
    request
        .input
        .push(InputItem::Message(Message::text(MessageRole::User, "fork")));
    session
        .invoke(&request, &cancel, &mut events)
        .await
        .unwrap();
    request.input.extend([
        InputItem::Message(Message::text(MessageRole::Assistant, "fork")),
        InputItem::Message(Message::text(MessageRole::User, "changed")),
    ]);
    request.instructions = Some("new instructions".into());
    session
        .invoke(&request, &cancel, &mut events)
        .await
        .unwrap();
    assert_eq!(events.0.len(), 4);
    session.close(&cancel).await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn responses_tool_result_continues_on_the_same_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = ResolvedApiTarget::new(
        format!("http://{}/v1", listener.local_addr().unwrap()),
        vec![],
    );
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        read(&mut socket).await;
        send(&mut socket, json!({"type":"response.completed","response":{"id":"tool-response","status":"completed","output":[{"type":"function_call","call_id":"c1","name":"lookup","arguments":"{}"}]}})).await;
        let next = read(&mut socket).await;
        assert_eq!(next["previous_response_id"], "tool-response");
        assert_eq!(next["input"][0]["type"], "function_call_output");
        completed(&mut socket, "done", "answer").await;
    });
    let cancel = CancellationSource::new().token();
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::OpenAiResponses,
        "gpt-5.6-luna",
        None,
        limits(),
        &cancel,
    )
    .await
    .unwrap();
    let mut request = ModelRequest::text("lookup");
    let mut sink = Events::default();
    let response = session.invoke(&request, &cancel, &mut sink).await.unwrap();
    let OutputItem::ToolCall(call) = response.output[0].clone() else {
        panic!("tool required");
    };
    request.input.push(InputItem::Message(Message {
        role: MessageRole::Assistant,
        content: vec![],
        tool_calls: vec![call.clone()],
    }));
    request.input.push(InputItem::ToolResult(ToolResult {
        call_id: call.id,
        name: call.name,
        content: vec![ContentPart::Text("result".into())],
        is_error: false,
    }));
    assert_eq!(
        session
            .invoke(&request, &cancel, &mut sink)
            .await
            .unwrap()
            .text(),
        "answer"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_and_invalid_events_retire_responses_without_replay() {
    for payload in [
        None,
        Some("bad-json"),
        Some(r#"{"type":"response.output_text.delta","response_id":"other","delta":"x"}"#),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target =
            ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
        let source = CancellationSource::new();
        let server_cancel = source.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            read(&mut socket).await;
            if let Some(payload) = payload {
                send(
                    &mut socket,
                    json!({"type":"response.created","response":{"id":"current"}}),
                )
                .await;
                socket
                    .send(WireMessage::Text(payload.into()))
                    .await
                    .unwrap();
            } else {
                server_cancel.cancel();
            }
            let _ = socket.next().await;
        });
        let mut session = ResponsesWebSocketSession::connect(
            &connector(),
            &target,
            ApiEndpoint::OpenAiResponses,
            "gpt-5.6-luna",
            None,
            limits(),
            &source.token(),
        )
        .await
        .unwrap();
        let result = session
            .invoke(
                &ModelRequest::text("input"),
                &source.token(),
                &mut Events::default(),
            )
            .await;
        assert!(result.is_err());
        assert!(!session.is_open());
        assert!(
            session
                .invoke(
                    &ModelRequest::text("new"),
                    &CancellationSource::new().token(),
                    &mut Events::default()
                )
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn realtime_handles_pcm_text_tools_and_cancelled_terminal_usage() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = ResolvedApiTarget::new(
        format!("http://{}/v1", listener.local_addr().unwrap()),
        vec![HttpHeader::new("Authorization", "Bearer fixture")],
    );
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            tcp,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(
                    request.uri().path_and_query().unwrap().as_str(),
                    "/v1/realtime?model=realtime-test"
                );
                assert!(request.headers().get("openai-beta").is_none());
                Ok(response)
            },
        )
        .await
        .unwrap();
        send(&mut socket, json!({"type":"session.created","session":{"id":"session","type":"realtime","audio":{"output":{"voice":"marin"}}}})).await;
        let config = read(&mut socket).await;
        assert_eq!(config["session"]["audio"]["input"]["format"]["rate"], 24000);
        assert!(config["session"]["audio"]["input"]["turn_detection"].is_null());
        send(&mut socket, json!({"type":"session.updated","session":{"id":"session","audio":{"output":{"voice":"marin"}}}})).await;
        assert_eq!(read(&mut socket).await["type"], "conversation.item.create");
        assert_eq!(read(&mut socket).await["audio"], "AAABAA==");
        assert_eq!(read(&mut socket).await["type"], "input_audio_buffer.commit");
        assert_eq!(read(&mut socket).await["type"], "response.create");
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r1"}}),
        )
        .await;
        send(&mut socket,json!({"type":"response.output_text.delta","response_id":"r1","item_id":"m1","delta":"hello"})).await;
        send(&mut socket,json!({"type":"response.output_audio.delta","response_id":"r1","item_id":"a1","delta":"AAABAA=="})).await;
        send(&mut socket,json!({"type":"response.output_item.done","response_id":"r1","item":{"type":"function_call","call_id":"tool","name":"lookup","arguments":"{}"}})).await;
        assert_eq!(read(&mut socket).await["item"]["call_id"], "tool");
        let cancel = read(&mut socket).await;
        assert_eq!(cancel["type"], "response.cancel");
        assert_eq!(cancel["response_id"], "r1");
        send(&mut socket,json!({"type":"response.done","response":{"id":"r1","status":"cancelled","usage":{"input_tokens":50,"output_tokens":10,"input_token_details":{"cached_tokens":20}}}})).await;
        assert!(socket.next().await.unwrap().unwrap().is_close());
    });
    let token = CancellationSource::new().token();
    let mut session =
        RealtimeSession::connect(&connector(), &target, "realtime-test", limits(), &token)
            .await
            .unwrap();
    let config = RealtimeConfig {
        output: RealtimeOutput::Audio {
            voice: "marin".into(),
        },
        ..Default::default()
    };
    session
        .send(RealtimeCommand::Configure(config.clone()), &token)
        .await
        .unwrap();
    assert!(matches!(
        session.receive(&token).await.unwrap(),
        RealtimeEvent::SessionUpdated
    ));
    session
        .send(
            RealtimeCommand::UserText {
                text: "hello".into(),
            },
            &token,
        )
        .await
        .unwrap();
    assert!(
        session
            .send(RealtimeCommand::AppendAudio { pcm16: vec![1] }, &token)
            .await
            .is_err()
    );
    session
        .send(
            RealtimeCommand::AppendAudio {
                pcm16: vec![0, 0, 1, 0],
            },
            &token,
        )
        .await
        .unwrap();
    session
        .send(RealtimeCommand::CommitAudio, &token)
        .await
        .unwrap();
    session
        .send(RealtimeCommand::CreateResponse, &token)
        .await
        .unwrap();
    assert!(
        session
            .send(RealtimeCommand::CreateResponse, &token)
            .await
            .is_err()
    );
    assert!(matches!(
        session.receive(&token).await.unwrap(),
        RealtimeEvent::ResponseCreated { .. }
    ));
    assert!(
        matches!(session.receive(&token).await.unwrap(), RealtimeEvent::TextDelta { text, .. } if text == "hello")
    );
    assert!(
        matches!(session.receive(&token).await.unwrap(), RealtimeEvent::AudioDelta { pcm16, .. } if pcm16 == vec![0,0,1,0])
    );
    let bad_voice = RealtimeConfig {
        output: RealtimeOutput::Audio {
            voice: "cedar".into(),
        },
        ..config
    };
    assert!(
        session
            .send(RealtimeCommand::Configure(bad_voice), &token)
            .await
            .is_err()
    );
    let RealtimeEvent::ToolCall { call, .. } = session.receive(&token).await.unwrap() else {
        panic!("tool expected");
    };
    session
        .send(
            RealtimeCommand::ToolResult {
                call_id: call.id,
                output: "result".into(),
            },
            &token,
        )
        .await
        .unwrap();
    session
        .send(RealtimeCommand::CancelResponse, &token)
        .await
        .unwrap();
    let RealtimeEvent::ResponseDone { status, usage, .. } = session.receive(&token).await.unwrap()
    else {
        panic!("terminal expected");
    };
    assert_eq!(status, RealtimeResponseStatus::Cancelled);
    assert_eq!(usage.unwrap().cached_input_tokens, Some(20));
    session.close(&token).await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn realtime_can_alternate_waiting_for_events_and_sending_microphone_input() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        send(
            &mut socket,
            json!({"type":"session.created","session":{"id":"session","type":"realtime"}}),
        )
        .await;
        assert_eq!(read(&mut socket).await["type"], "input_audio_buffer.clear");
        send(&mut socket, json!({"type":"input_audio_buffer.cleared"})).await;
        let _ = socket.next().await;
    });
    let source = CancellationSource::new();
    let token = source.token();
    let mut session =
        RealtimeSession::connect(&connector(), &target, "realtime-test", limits(), &token)
            .await
            .unwrap();
    let mut receive = Box::pin(session.receive(&token));
    assert!(futures::poll!(&mut receive).is_pending());
    drop(receive);
    session
        .send(RealtimeCommand::ClearAudio, &token)
        .await
        .unwrap();
    assert!(session.is_open());
    assert!(matches!(
        session.receive(&token).await.unwrap(),
        RealtimeEvent::Other { .. }
    ));
    source.cancel();
    assert!(matches!(
        session.receive(&token).await,
        Err(ApiError::Cancelled(_))
    ));
    assert!(!session.is_open());
    server.await.unwrap();
}

#[tokio::test]
async fn explicit_warmup_continues_with_an_empty_delta_without_fabricating_output() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        assert_eq!(read(&mut socket).await["generate"], false);
        send(&mut socket, json!({"type":"response.completed","response":{"id":"warm","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":0}}})).await;
        let generated = read(&mut socket).await;
        assert_eq!(generated["previous_response_id"], "warm");
        assert_eq!(generated["input"], json!([]));
        assert!(generated.get("generate").is_none());
        completed(&mut socket, "generated", "answer").await;
    });
    let token = CancellationSource::new().token();
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::OpenAiResponses,
        "gpt-5.6-luna",
        None,
        limits(),
        &token,
    )
    .await
    .unwrap();
    let request = ModelRequest::text("request");
    let warm = session.warm_up(&request, &token).await.unwrap();
    assert_eq!(warm.response_id, "warm");
    assert_eq!(warm.usage.unwrap().output_tokens, Some(0));
    assert_eq!(
        session
            .invoke(&request, &token, &mut Events::default())
            .await
            .unwrap()
            .text(),
        "answer"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn abandoning_an_inflight_response_closes_its_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let (started, accepted) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        read(&mut socket).await;
        started.send(()).unwrap();
        let _ = socket.next().await;
    });
    let token = CancellationSource::new().token();
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::OpenAiResponses,
        "gpt-5.6-luna",
        None,
        limits(),
        &token,
    )
    .await
    .unwrap();
    let request = ModelRequest::text("input");
    let mut events = Events::default();
    {
        let mut invocation = Box::pin(session.invoke(&request, &token, &mut events));
        tokio::select! { _=&mut invocation => panic!("server never completes"), _=accepted => {} }
    }
    assert!(!session.is_open());
    tokio::time::timeout(Duration::from_secs(1), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn rejected_realtime_create_does_not_leave_the_session_busy() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        send(
            &mut socket,
            json!({"type":"session.created","session":{"type":"realtime","id":"s"}}),
        )
        .await;
        let rejected = read(&mut socket).await;
        send(&mut socket,json!({"type":"error","error":{"type":"invalid_request_error","code":null,"event_id":rejected["event_id"]}})).await;
        read(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"response.created","response":{"id":"r"}}),
        )
        .await;
        send(
            &mut socket,
            json!({"type":"response.done","response":{"id":"r","status":"completed"}}),
        )
        .await;
    });
    let token = CancellationSource::new().token();
    let mut session =
        RealtimeSession::connect(&connector(), &target, "realtime-test", limits(), &token)
            .await
            .unwrap();
    session
        .send(RealtimeCommand::CreateResponse, &token)
        .await
        .unwrap();
    assert!(matches!(
        session.receive(&token).await.unwrap(),
        RealtimeEvent::Error { code: None, .. }
    ));
    session
        .send(RealtimeCommand::CreateResponse, &token)
        .await
        .unwrap();
    assert!(matches!(
        session.receive(&token).await.unwrap(),
        RealtimeEvent::ResponseCreated { .. }
    ));
    assert!(matches!(
        session.receive(&token).await.unwrap(),
        RealtimeEvent::ResponseDone {
            status: RealtimeResponseStatus::Completed,
            usage: None,
            ..
        }
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn response_timeout_is_not_reported_as_a_completed_turn() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        read(&mut socket).await;
        let _ = socket.next().await;
    });
    let token = CancellationSource::new().token();
    let mut options = limits();
    options.idle_timeout = Duration::from_millis(50);
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::OpenAiResponses,
        "gpt-5.6-luna",
        None,
        options,
        &token,
    )
    .await
    .unwrap();
    assert!(matches!(
        session
            .invoke(&ModelRequest::text("input"), &token, &mut Events::default())
            .await,
        Err(ApiError::Transport(_))
    ));
    assert!(!session.is_open());
    server.await.unwrap();
}

#[tokio::test]
async fn warmup_accepts_static_instructions_before_user_input_exists() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let warm = read(&mut socket).await;
        assert_eq!(warm["input"], json!([]));
        assert_eq!(warm["instructions"], "static instructions");
        assert_eq!(warm["generate"], false);
        send(&mut socket,json!({"type":"response.completed","response":{"id":"prepared","status":"completed","output":[]}})).await;
        let turn = read(&mut socket).await;
        assert_eq!(turn["previous_response_id"], "prepared");
        assert_eq!(turn["input"].as_array().unwrap().len(), 1);
        completed(&mut socket, "done", "answer").await;
    });
    let token = CancellationSource::new().token();
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::OpenAiResponses,
        "gpt-5.6-luna",
        None,
        limits(),
        &token,
    )
    .await
    .unwrap();
    let mut request = ModelRequest::text("first input");
    let input = std::mem::take(&mut request.input);
    request.prompt_cache_prefix_end = None;
    request.instructions = Some("static instructions".into());
    session.warm_up(&request, &token).await.unwrap();
    request.input = input;
    session
        .invoke(&request, &token, &mut Events::default())
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn wire_heartbeats_keep_a_reasoning_response_alive_without_text_progress() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target =
        ResolvedApiTarget::new(format!("http://{}", listener.local_addr().unwrap()), vec![]);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        read(&mut socket).await;
        for _ in 0..6 {
            socket
                .send(WireMessage::Ping(vec![1].into()))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        completed(&mut socket, "done", "answer").await;
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() {
                break;
            }
        }
    });
    let token = CancellationSource::new().token();
    let mut options = limits();
    options.idle_timeout = Duration::from_millis(150);
    let mut session = ResponsesWebSocketSession::connect(
        &connector(),
        &target,
        ApiEndpoint::OpenAiResponses,
        "gpt-5.6-luna",
        None,
        options,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        session
            .invoke(&ModelRequest::text("input"), &token, &mut Events::default())
            .await
            .unwrap()
            .text(),
        "answer"
    );
    session.close(&token).await.unwrap();
    server.await.unwrap();
}
