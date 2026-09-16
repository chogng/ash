use super::*;
use ash_api::WebSocketSessionConfig;
use ash_http_client::HttpClientConfig;
use ash_http_client::OutboundNetworkSnapshot;
use ash_websocket_client::WebSocketConnector;

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
        let voice = ash_api::LiveConfig {
            voice: "marin".into(),
            instructions: String::new(),
        };
        for (config, model) in [
            (config.clone(), model_ref("openai-compatible", "gpt-live-1")),
            (
                provider_config("openai"),
                model_ref("openai", "gpt-5.6-luna"),
            ),
        ] {
            assert!(matches!(
                runtime
                    .connect_live(
                        &config,
                        &model,
                        &voice,
                        &connector,
                        WebSocketSessionConfig::default(),
                        &cancellation
                    )
                    .await,
                Err(ModelProviderError::Unavailable(_))
            ));
        }
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
