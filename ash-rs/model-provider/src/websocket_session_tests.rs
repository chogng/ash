use super::*;
use ash_api::WebSocketSessionConfig;
use ash_http_client::HttpClientConfig;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_websocket_client::WebSocketConnector;
use futures::SinkExt;
use futures::StreamExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

fn local_connector() -> WebSocketConnector {
    WebSocketConnector::new(
        OutboundNetworkSnapshot::new(
            HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn stored_api_key_authenticates_all_three_openai_websocket_services() {
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &provider_api_key_secret_key(&provider_id("openai")),
            &SecretValue::new(b"socket-test-key".to_vec()),
        )
        .unwrap();
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        Arc::new(FailingTransport),
        secrets,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = provider_config_with_endpoint(
        "openai",
        format!("http://{}/v1", listener.local_addr().unwrap()),
    );
    let server = tokio::spawn(async move {
        for path in ["/v1/responses", "/v1/realtime", "/v1/live/sessions"] {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    assert_eq!(request.uri().path(), path);
                    assert_eq!(request.headers()["authorization"], "Bearer socket-test-key");
                    if path == "/v1/realtime" {
                        assert_eq!(request.uri().query(), Some("model=realtime-fixture"));
                    }
                    Ok(response)
                },
            )
            .await
            .unwrap();
            match path {
                "/v1/realtime" => {
                    socket
                        .send(Message::Text(
                            json!({"type":"session.created","session":{"type":"realtime","id":"realtime-1"}})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                "/v1/live/sessions" => {
                    let start: Value = serde_json::from_str(
                        socket.next().await.unwrap().unwrap().to_text().unwrap(),
                    )
                    .unwrap();
                    assert_eq!(start["type"], "session.start");
                    socket
                        .send(Message::Text(
                            json!({"type":"session.started","session":{"id":"live-1","model":"gpt-live-1"}})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                _ => {}
            }
        }
    });
    let cancellation = CancellationSource::new().token();
    let responses = runtime
        .connect_responses(
            &config,
            &model_ref("openai", "gpt-5.6"),
            None,
            local_connector(),
            WebSocketSessionConfig::default(),
            &cancellation,
        )
        .await
        .unwrap();
    assert!(responses.is_open());
    drop(responses);
    runtime
        .connect_realtime(
            &config,
            &model_ref("openai", "realtime-fixture"),
            &local_connector(),
            WebSocketSessionConfig::default(),
            &cancellation,
        )
        .await
        .unwrap();
    runtime
        .connect_voice(
            &config,
            &ash_model_provider_config::VoiceModelConfig::default(),
            "test",
            &local_connector(),
            WebSocketSessionConfig::default(),
            &cancellation,
        )
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn responses_socket_reconnects_after_key_rotation_and_closes_after_deletion() {
    let secrets = Arc::new(MemorySecretStore::default());
    let key = provider_api_key_secret_key(&provider_id("openai"));
    secrets
        .store(&key, &SecretValue::new(b"first-key".to_vec()))
        .unwrap();
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        Arc::new(FailingTransport),
        secrets.clone(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = provider_config_with_endpoint(
        "openai",
        format!("http://{}/v1", listener.local_addr().unwrap()),
    );
    let server = tokio::spawn(async move {
        for expected in ["Bearer first-key", "Bearer second-key"] {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response| {
                    assert_eq!(request.headers()["authorization"], expected);
                    Ok(response)
                },
            )
            .await
            .unwrap();
            if expected == "Bearer second-key" {
                let request: Value =
                    serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                        .unwrap();
                assert_eq!(request["generate"], false);
                socket
                    .send(Message::Text(
                        json!({"type":"response.completed","response":{"id":"warm","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
        }
    });
    let cancellation = CancellationSource::new().token();
    let mut session = runtime
        .connect_responses(
            &config,
            &model_ref("openai", "gpt-5.6"),
            None,
            local_connector(),
            WebSocketSessionConfig::default(),
            &cancellation,
        )
        .await
        .unwrap();
    secrets
        .store(&key, &SecretValue::new(b"second-key".to_vec()))
        .unwrap();
    assert_eq!(
        session
            .warm_up(&ModelRequest::text("warm"), &cancellation)
            .await
            .unwrap()
            .response_id,
        "warm"
    );
    secrets.delete(&key).unwrap();
    assert!(matches!(
        session
            .warm_up(&ModelRequest::text("again"), &cancellation)
            .await,
        Err(ModelProviderError::Credential(_))
    ));
    assert!(!session.is_open());
    server.await.unwrap();
}

#[test]
fn websocket_factories_require_their_own_declared_service_protocols() {
    let runtime = ModelProviderRuntime::builtin_with_client(Arc::new(FailingTransport));
    let connector =
        WebSocketConnector::new(OutboundNetworkSnapshot::new(HttpClientConfig::new()).unwrap());
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let cancellation = CancellationSource::new().token();
        let config = provider_config_with_endpoint("openai-compatible", "https://example.test/v1");
        let model = model_ref("openai-compatible", "fixture");
        assert!(matches!(
            runtime
                .connect_voice(
                    &config,
                    &ash_model_provider_config::VoiceModelConfig::default(),
                    "",
                    &connector,
                    WebSocketSessionConfig::default(),
                    &cancellation
                )
                .await,
            Err(ModelProviderError::Unavailable(_))
        ));
        let selection = ash_model_provider_config::VoiceModelConfig {
            model: Some(model_ref("openai", "gpt-5.6-luna").model),
            voice: None,
        };
        assert!(matches!(
            runtime
                .connect_voice(
                    &provider_config("openai"),
                    &selection,
                    "",
                    &connector,
                    WebSocketSessionConfig::default(),
                    &cancellation
                )
                .await,
            Err(ModelProviderError::Config(
                ash_model_provider_config::ProviderConfigError::ModelNotRegistered { .. }
            ))
        ));
        assert!(matches!(
            runtime
                .connect_responses(
                    &config,
                    &model,
                    None,
                    connector.clone(),
                    WebSocketSessionConfig::default(),
                    &cancellation
                )
                .await,
            Err(ModelProviderError::Unavailable(_))
        ));
        assert!(matches!(
            runtime
                .connect_realtime(
                    &config,
                    &model,
                    &connector,
                    WebSocketSessionConfig::default(),
                    &cancellation
                )
                .await,
            Err(ModelProviderError::Unavailable(_))
        ));
        assert!(matches!(
            runtime
                .connect_realtime(
                    &provider_config("openai"),
                    &model_ref("openai", "gpt-5.6-luna"),
                    &connector,
                    WebSocketSessionConfig::default(),
                    &cancellation
                )
                .await,
            Err(ModelProviderError::Unavailable(_))
        ));
    });
}

#[test]
#[ignore = "Real Luna / low Responses WebSocket; read-only Codex credentials"]
fn live_luna_websocket_uses_two_responses_on_one_caller_owned_session() {
    use sha2::Digest;
    let home = ash_chatgpt::codex_home().unwrap();
    let fingerprint = || {
        std::fs::read(home.join("auth.json"))
            .ok()
            .map(|value| sha2::Sha256::digest(value))
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
    let connector =
        WebSocketConnector::new(OutboundNetworkSnapshot::new(HttpClientConfig::new()).unwrap());
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result: Result<(), ModelProviderError> = executor.block_on(async {
        let cancellation = CancellationSource::new().token();
        let scope = format!(
            "luna-ws-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut session = runtime
            .connect_responses(
                &provider_config("openai"),
                &model_ref("openai", "gpt-5.6-luna"),
                Some(scope.clone()),
                connector,
                WebSocketSessionConfig::default(),
                &cancellation,
            )
            .await?;
        let mut request = ModelRequest::text("Reply exactly ACK.");
        request.instructions =
            Some("Synthetic WebSocket test. Do not use tools. Reply exactly ACK.".into());
        request.reasoning = Some(ash_protocol::ReasoningConfig {
            effort: ash_protocol::ReasoningEffort::Low,
            summary: false,
        });
        request.prompt_cache_key = Some(scope);
        for index in 0..2 {
            let response = session
                .invoke(&request, &cancellation, &mut RecordedModelEvents::default())
                .await?;
            assert_eq!(response.text().trim(), "ACK");
            eprintln!("LUNA_WS turn={} usage={:?}", index + 1, response.usage);
            request.input.push(ash_protocol::InputItem::Message(
                ash_protocol::Message::text(ash_protocol::MessageRole::Assistant, response.text()),
            ));
            request.input.push(ash_protocol::InputItem::Message(
                ash_protocol::Message::text(
                    ash_protocol::MessageRole::User,
                    "Reply exactly ACK again.",
                ),
            ));
        }
        assert!(session.is_open());
        eprintln!("LUNA_WS transmission={:?}", session.connection_stats());
        assert_eq!(session.connection_stats().requests_sent, 2);
        assert_eq!(session.connection_stats().incremental_requests, 1);
        session.close(&cancellation).await?;
        Ok(())
    });
    assert!(
        before == fingerprint(),
        "Codex authentication must remain unchanged"
    );
    if let Err(error) = result {
        let category = match error {
            ModelProviderError::Api(ApiError::HttpStatus(status)) => format!("HTTP {status}"),
            ModelProviderError::Credential(_) => "credentials".into(),
            ModelProviderError::InvalidRequest(_) => "invalid request".into(),
            ModelProviderError::InvalidResponse(_) => "invalid response".into(),
            ModelProviderError::Api(ApiError::Transport(_)) => "transport".into(),
            _ => "model error".into(),
        };
        panic!("Luna WebSocket failed: {category}");
    }
}
