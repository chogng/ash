use super::*;
use ash_api::InputItem;
use ash_api::OutputItem;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;

#[tokio::test]
#[ignore = "Real Grok subscription request: grok-4.6 / low, read-only access token, no refresh"]
async fn live_grok_auth_is_read_only_and_uses_the_ash_model_pipeline() {
    use sha2::Digest;

    // Deserialize only the access token. The CLI retains ownership of its rotating
    // refresh token; this test cannot refresh, import, or rewrite that credential.
    #[derive(serde::Deserialize)]
    struct GrokAuth {
        key: String,
        auth_mode: String,
    }

    let home = std::env::home_dir().expect("user home must resolve");
    let path = home.join(".grok/auth.json");
    let bytes = SecretValue::new(std::fs::read(&path).expect("Grok auth must be readable"));
    let before = sha2::Sha256::digest(bytes.expose());
    let mut entries: std::collections::BTreeMap<String, GrokAuth> =
        serde_json::from_slice(bytes.expose()).expect("Grok auth format must be valid");
    let credential = entries
        .remove("https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828")
        .expect("an official Grok OAuth login is required");
    assert!(credential.auth_mode == "oidc" && !credential.key.is_empty());
    let secrets = Arc::new(MemorySecretStore::default());
    secrets
        .store(
            &SecretKey::new("provider/xai/current/oauth").unwrap(),
            &SecretValue::new(
                serde_json::to_vec(&json!({
                    "access_token": credential.key,
                    "refresh_token": "",
                    "token_type": "Bearer",
                    "scope": "",
                    "expires_at": null,
                    "account_id": "grok-live-test",
                    "credential_revision": 1
                }))
                .unwrap(),
            ),
        )
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = Arc::new(ash_client::AshClient::new(Arc::new(
        ash_http_client::UreqHttpClient::new().unwrap(),
    )));
    let auth = xai::XaiOAuth::with_client(secrets, client.clone(), dir.path().join("lock"));
    let runtime = ModelProviderRuntime::builtin_with_client(client).with_xai_oauth(auth);
    let config = ModelProviderConfig::new(ProviderId::new("xai").unwrap());
    let binding = runtime.catalog_binding(&config).unwrap().unwrap();
    let catalog = runtime
        .models_manager_for_config(&config)
        .unwrap()
        .refresh(binding.scope().clone(), binding.source())
        .await;
    let fingerprint = || {
        sha2::Sha256::digest(
            SecretValue::new(std::fs::read(&path).expect("Grok auth must remain readable"))
                .expose(),
        )
    };
    assert!(
        before == fingerprint(),
        "Grok auth.json must remain unchanged"
    );
    assert!(catalog.is_ok(), "real xAI model catalog must load");
    println!("xAI account model catalog loaded with the existing Grok access token");
    let model = runtime
        .build_model(
            &config,
            &ModelRef::new(config.provider.clone(), ModelId::new("grok-4.6").unwrap()),
        )
        .expect("grok-4.6 must be available in the account catalog");
    let mut request = ash_api::ModelRequest::text(
        "Return this exact string without punctuation or extra text: ASH_AUTH_OK",
    );
    request.instructions = Some("Reply briefly. Do not use tools.".into());
    request.reasoning = Some(ash_protocol::ReasoningConfig {
        effort: ash_protocol::ReasoningEffort::Low,
        summary: false,
    });
    let result = model.invoke_with_cancellation(
        &request,
        &ash_async_utils::CancellationSource::new().token(),
    );
    assert!(
        before == fingerprint(),
        "Grok auth.json must remain unchanged"
    );
    let response = result.unwrap_or_else(|error| {
        // Never print credentials, headers, or upstream error bodies.
        let category = match error {
            ModelProviderError::Api(ApiError::HttpStatus(status)) => {
                panic!("xAI subscription request returned HTTP {status}")
            }
            ModelProviderError::Api(ApiError::Transport(_)) => "transport",
            ModelProviderError::AuthFailed(_) => "authentication",
            ModelProviderError::Credential(_) => "credential",
            ModelProviderError::InvalidResponse(_) => "invalid response",
            ModelProviderError::InvalidRequest(_) => "invalid request",
            _ => "model request",
        };
        panic!("xAI subscription request failed: {category}");
    });
    assert!(
        response.text().trim() == "ASH_AUTH_OK",
        "expected test marker"
    );
    println!("xAI catalog and grok-4.6 / low Responses request passed; Grok auth unchanged");
}

#[derive(Default)]
struct Proxy {
    requests: Mutex<Vec<ClientRequest>>,
    status: Mutex<u16>,
    statuses: Mutex<std::collections::VecDeque<u16>>,
    partial: std::sync::atomic::AtomicBool,
}

impl OperationClient for Proxy {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        if request.url() == "https://auth.x.ai/oauth2/token" {
            return Ok(ClientResponse::new(200, vec![], br#"{"access_token":"fresh-token","refresh_token":"fresh-refresh","expires_in":3600,"token_type":"Bearer"}"#.to_vec()));
        }
        assert_eq!(
            request.url(),
            "https://cli-chat-proxy.grok.com/v1/models-v2"
        );
        Ok(ClientResponse::new(200, Vec::new(), serde_json::to_vec(&json!({"data":[
            {"model":"grok-a","apiBackend":"responses","contextWindow":500000,"reasoningEfforts":[{"value":"high"}]},
            {"model":"grok-b","apiBackend":"responses","contextWindow":500000}
        ]})).unwrap()))
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        assert_eq!(
            request.url(),
            "https://cli-chat-proxy.grok.com/v1/responses"
        );
        if self.partial.load(std::sync::atomic::Ordering::Relaxed) {
            sink.emit(
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
            )?;
        }
        let status = self
            .statuses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(*self.status.lock().unwrap());
        if status != 0 && status != 200 {
            return Ok(ClientResponse::new(status, Vec::new(), Vec::new()));
        }
        let response = json!({"type":"response.completed","response":{"status":"completed","output":[
            {"type":"reasoning","id":"r-1","summary":[],"encrypted_content":"opaque"},
            {"type":"message","content":[{"type":"output_text","text":"hello"}]}
        ]}});
        sink.emit(format!("data: {response}\n\n").as_bytes())?;
        Ok(ClientResponse::new(200, Vec::new(), Vec::new()))
    }
}

fn store_account(secrets: &MemorySecretStore, account_id: &str) {
    secrets.store(&SecretKey::new("provider/xai/current/oauth").unwrap(), &SecretValue::new(serde_json::to_vec(&json!({
        "access_token":"fixture-token", "refresh_token":"fixture-refresh", "token_type":"Bearer", "scope":"", "expires_at":4102444800u64, "account_id":account_id,"credential_revision":1
    })).unwrap())).unwrap();
}

#[tokio::test]
async fn xai_subscription_uses_live_catalog_replays_scoped_reasoning_and_observes_logout() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    store_account(&secrets, "account-a");
    secrets
        .store(
            &provider_api_key_secret_key(&ProviderId::new("xai").unwrap()),
            &SecretValue::new(b"xai-api-key".to_vec()),
        )
        .unwrap();
    let proxy = Arc::new(Proxy::default());
    let auth = xai::XaiOAuth::with_client(secrets.clone(), proxy.clone(), dir.path().join("lock"));
    let runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        proxy.clone(),
        secrets.clone(),
    )
    .with_xai_oauth(auth);
    let config = ModelProviderConfig::new(ProviderId::new("xai").unwrap());
    let binding = runtime.catalog_binding(&config).unwrap().unwrap();
    runtime
        .models_manager_for_config(&config)
        .unwrap()
        .refresh(binding.scope().clone(), binding.source())
        .await
        .unwrap();
    let model_ref = |id| ModelRef::new(config.provider.clone(), ModelId::new(id).unwrap());
    let model = runtime.build_model(&config, &model_ref("grok-a")).unwrap();
    let mut request = ash_api::ModelRequest::text("hello");
    let token = ash_async_utils::CancellationSource::new().token();
    let response = model.invoke_with_cancellation(&request, &token).unwrap();
    let state = response
        .output
        .iter()
        .find_map(|item| match item {
            OutputItem::ReasoningState(state) => Some(state.clone()),
            _ => None,
        })
        .unwrap();
    assert!(!state.scope.is_empty());
    request.input.insert(0, InputItem::Reasoning(state.clone()));
    model.invoke_with_cancellation(&request, &token).unwrap();
    let requests = proxy.requests.lock().unwrap();
    let body: serde_json::Value = serde_json::from_slice(requests.last().unwrap().body()).unwrap();
    assert_eq!(body["input"][0], state.item);
    assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    drop(requests);
    runtime
        .build_model(&config, &model_ref("grok-b"))
        .unwrap()
        .invoke_with_cancellation(&request, &token)
        .unwrap();
    let requests = proxy.requests.lock().unwrap();
    let body: serde_json::Value = serde_json::from_slice(requests.last().unwrap().body()).unwrap();
    assert_eq!(body["input"].as_array().unwrap().len(), 1);
    drop(requests);
    *proxy.status.lock().unwrap() = 403;
    assert!(matches!(
        model.invoke_with_cancellation(&request, &token),
        Err(ModelProviderError::Api(ApiError::HttpStatus(403)))
    ));
    assert_eq!(proxy.requests.lock().unwrap().len(), 5);
    secrets
        .delete(&SecretKey::new("provider/xai/current/oauth").unwrap())
        .unwrap();
    assert!(model.invoke_with_cancellation(&request, &token).is_err());
    assert_eq!(proxy.requests.lock().unwrap().len(), 5);
    assert!(runtime.catalog_binding(&config).unwrap().is_none());
    store_account(&secrets, "account-b");
    let new_binding = runtime.catalog_binding(&config).unwrap().unwrap();
    assert_ne!(binding.scope(), new_binding.scope());
    assert!(model.invoke_with_cancellation(&request, &token).is_err());
    assert_eq!(proxy.requests.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn xai_subscription_retries_only_one_http_401_before_any_stream_output() {
    for (statuses, partial, expected_calls, expected_refreshes, succeeds) in [
        (vec![401, 200], false, 2, 1, true),
        (vec![401, 401], false, 2, 1, false),
        (vec![403], false, 1, 0, false),
        (vec![426], false, 1, 0, false),
        (vec![429], false, 1, 0, false),
        (vec![401], true, 1, 0, false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        store_account(&secrets, "account-a");
        let proxy = Arc::new(Proxy::default());
        *proxy.statuses.lock().unwrap() = statuses.clone().into();
        proxy
            .partial
            .store(partial, std::sync::atomic::Ordering::Relaxed);
        let auth = xai::XaiOAuth::with_client(secrets, proxy.clone(), dir.path().join("lock"));
        let runtime =
            ModelProviderRuntime::builtin_with_client(proxy.clone()).with_xai_oauth(auth.clone());
        let config = ModelProviderConfig::new(ProviderId::new("xai").unwrap());
        let binding = runtime.catalog_binding(&config).unwrap().unwrap();
        runtime
            .models_manager_for_config(&config)
            .unwrap()
            .refresh(binding.scope().clone(), binding.source())
            .await
            .unwrap();
        let model = runtime
            .build_model(
                &config,
                &ModelRef::new(config.provider.clone(), ModelId::new("grok-a").unwrap()),
            )
            .unwrap();
        let result = model.invoke(&ash_api::ModelRequest::text("hi"));
        assert_eq!(
            result.is_ok(),
            succeeds,
            "{statuses:?}, partial={partial}: {result:?}"
        );
        let requests = proxy.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url().ends_with("/responses"))
                .count(),
            expected_calls
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url().ends_with("/token"))
                .count(),
            expected_refreshes
        );
        if statuses == [401, 401] {
            assert!(auth.api_target().is_err());
        }
    }
}
