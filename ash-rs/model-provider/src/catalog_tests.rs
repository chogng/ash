use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_model_provider_config::ModelId;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_models_manager::CatalogQuery;
use ash_models_manager::CatalogReadPolicy;
use ash_models_manager::CatalogReadSource;
use ash_models_manager::CatalogSourceErrorKind;
use ash_protocol::CapabilitySupport;
use ash_protocol::ProviderId;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
struct CapturedDiagnostics(Mutex<Vec<response_debug_context::ResponseDiagnostic>>);

impl response_debug_context::ResponseDiagnosticSink for CapturedDiagnostics {
    fn record_response(&self, diagnostic: response_debug_context::ResponseDiagnostic) {
        self.0.lock().unwrap().push(diagnostic);
    }
}

#[test]
fn catalog_diagnostics_retain_response_evidence_after_error_mapping() {
    struct Rejected;
    impl OperationClient for Rejected {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            Ok(ClientResponse::new(
                401,
                vec![
                    ash_http_client::HttpHeader::new("x-oai-request-id", "catalog-rejected"),
                    ash_http_client::HttpHeader::new("set-cookie", "secret-cookie"),
                ],
                b"secret-body".to_vec(),
            ))
        }
    }
    let diagnostics = Arc::new(CapturedDiagnostics::default());
    let runtime = crate::ModelProviderRuntime::builtin_with_client(Arc::new(Rejected))
        .with_response_diagnostics(diagnostics.clone());
    let binding = runtime
        .catalog_binding(&ModelProviderConfig::new(
            ProviderId::new("openai").unwrap(),
        ))
        .unwrap()
        .unwrap();
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(
            runtime
                .models_manager()
                .refresh(binding.scope().clone(), binding.source()),
        );
    assert!(matches!(
        result,
        Err(ash_models_manager::ModelsManagerError::Source { .. })
    ));
    let records = diagnostics.0.lock().unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(
        record.operation,
        response_debug_context::ResponseOperation::ModelCatalog
    );
    assert_eq!(
        record.outcome,
        response_debug_context::DiagnosticOutcome::Failed
    );
    assert_eq!(
        record
            .first_unauthorized
            .as_ref()
            .unwrap()
            .response
            .request_id
            .as_deref(),
        Some("catalog-rejected")
    );
    assert!(record.latest.as_ref().unwrap().auth_headers.is_empty());
    assert!(!serde_json::to_string(record).unwrap().contains("secret"));
}

#[test]
fn cancelled_catalog_operation_retains_its_sanitized_failure() {
    struct Cancelled;
    impl OperationClient for Cancelled {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            Err(ClientError::Cancelled("private cancellation detail".into()))
        }
    }
    let diagnostics = Arc::new(CapturedDiagnostics::default());
    let runtime = crate::ModelProviderRuntime::builtin_with_client(Arc::new(Cancelled))
        .with_response_diagnostics(diagnostics.clone());
    let binding = runtime
        .catalog_binding(&ModelProviderConfig::new(
            ProviderId::new("openai").unwrap(),
        ))
        .unwrap()
        .unwrap();
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(
            runtime
                .models_manager()
                .refresh(binding.scope().clone(), binding.source()),
        );
    assert!(result.is_err());
    let records = diagnostics.0.lock().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].outcome,
        response_debug_context::DiagnosticOutcome::Cancelled
    );
    assert_eq!(
        records[0].latest.as_ref().unwrap().outcome,
        response_debug_context::RequestOutcome::Cancelled
    );
    assert!(
        !serde_json::to_string(&records[0])
            .unwrap()
            .contains("private")
    );
}

#[test]
fn dropping_catalog_future_records_abandonment_once() {
    use std::future::Future;
    struct Rejected;
    impl OperationClient for Rejected {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            Ok(ClientResponse::new(401, vec![], vec![]))
        }
    }
    let diagnostics = Arc::new(CapturedDiagnostics::default());
    let provider = crate::ModelProviderRuntime::builtin_with_client(Arc::new(Rejected))
        .with_response_diagnostics(diagnostics.clone());
    let binding = provider
        .catalog_binding(&ModelProviderConfig::new(
            ProviderId::new("openai").unwrap(),
        ))
        .unwrap()
        .unwrap();
    let manager = provider.models_manager();
    let executor = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let entered = executor.enter();
    let mut future = Box::pin(manager.refresh(binding.scope().clone(), binding.source()));
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(future.as_mut().poll(&mut context).is_pending());
    drop(future);
    drop(entered);
    executor.shutdown_timeout(Duration::from_secs(2));
    let reports = diagnostics.0.lock().unwrap();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].attempts, 1);
    assert_eq!(
        reports[0].outcome,
        response_debug_context::DiagnosticOutcome::Abandoned
    );
}

struct CatalogClient {
    request: Mutex<Option<ClientRequest>>,
}

impl ash_client::OperationClient for CatalogClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        *self.request.lock().unwrap() = Some(request.clone());
        let body = if request.url().ends_with("/api/tags") {
            br#"{"models":[{"name":"qwen3:8b"},{"name":"nomic-embed-text"}]}"#.to_vec()
        } else if request
            .body()
            .windows("nomic-embed-text".len())
            .any(|value| value == b"nomic-embed-text")
        {
            br#"{"capabilities":["embedding"]}"#.to_vec()
        } else {
            br#"{"capabilities":["completion","tools"]}"#.to_vec()
        };
        Ok(ClientResponse::new(200, Vec::new(), body))
    }
}

#[test]
fn ollama_catalog_uses_shared_client_and_adds_installed_models() {
    let client = Arc::new(CatalogClient {
        request: Mutex::new(None),
    });
    let runtime =
        crate::ModelProviderRuntime::with_client(ProviderConfigRegistry::builtin(), client.clone());
    let config = ModelProviderConfig::new(ProviderId::new("ollama").unwrap());
    let binding = runtime.catalog_binding(&config).unwrap().unwrap();

    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(runtime.models_manager().read(
            binding.scope().clone(),
            CatalogReadPolicy::RequireFresh,
            CatalogReadSource::dynamic(binding.source()),
        ))
        .unwrap();

    let models = runtime
        .models_manager()
        .list(&[binding.scope().clone()], &CatalogQuery::all())
        .unwrap();
    assert_eq!(
        models
            .iter()
            .map(|entry| entry.model().model.as_str())
            .collect::<Vec<_>>(),
        vec!["qwen3:8b"]
    );
    assert_eq!(
        client.request.lock().unwrap().as_ref().unwrap().url(),
        "http://localhost:11434/api/show"
    );
    assert_eq!(
        models[0].info().capabilities.tools,
        CapabilitySupport::Supported
    );
}

#[test]
fn providers_without_dynamic_discovery_return_no_binding() {
    let runtime = crate::ModelProviderRuntime::builtin_with_client(Arc::new(CatalogClient {
        request: Mutex::new(None),
    }));
    let config = ModelProviderConfig::new(ProviderId::new("anthropic").unwrap());

    assert!(runtime.catalog_binding(&config).unwrap().is_none());
}

#[test]
fn openai_catalog_handles_empty_lists_invalid_payloads_and_http_errors() {
    struct Client {
        responses: Mutex<std::collections::VecDeque<ClientResponse>>,
    }
    impl OperationClient for Client {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            Ok(self.responses.lock().unwrap().pop_front().unwrap())
        }
    }
    let client = Arc::new(Client {
        responses: Mutex::new(std::collections::VecDeque::from([
            ClientResponse::new(
                200,
                vec![],
                br#"{"data":[{"id":"example-model"}]}"#.to_vec(),
            ),
            ClientResponse::new(200, vec![], br#"{"data":[]}"#.to_vec()),
            ClientResponse::new(200, vec![], br#"{"wrong":[]}"#.to_vec()),
            ClientResponse::new(401, vec![], b"sensitive-response-body".to_vec()),
        ])),
    });
    let runtime = crate::ModelProviderRuntime::builtin_with_client(client);
    let binding = runtime
        .catalog_binding(&ModelProviderConfig::new(
            ProviderId::new("openai").unwrap(),
        ))
        .unwrap()
        .unwrap();
    let executor = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let manager = runtime.models_manager();
    let first = executor
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();
    assert_eq!(
        first
            .entries()
            .iter()
            .filter(|entry| entry.availability() == ash_protocol::ModelAvailability::Available)
            .count(),
        1
    );
    let empty = executor
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();
    assert!(
        empty
            .entries()
            .iter()
            .all(|entry| entry.availability() != ash_protocol::ModelAvailability::Available)
    );
    assert!(
        executor
            .block_on(manager.refresh(binding.scope().clone(), binding.source()))
            .is_err()
    );
    let error = executor
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("401"));
    assert!(!error.contains("sensitive-response-body"));
}

#[test]
fn custom_catalog_fetches_models_with_its_own_key_and_invalidates_scope() {
    use crate::ProviderCredentialService;
    use ash_model_provider_config::CustomProviderConfig;
    use ash_model_provider_config::CustomProviderProtocol;
    struct Client {
        requests: Mutex<Vec<ClientRequest>>,
        body: Vec<u8>,
    }
    impl OperationClient for Client {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(ClientResponse::new(200, vec![], self.body.clone()))
        }
    }
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    let client = Arc::new(Client {
        requests: Mutex::new(vec![]),
        body: br#"{"data":[{"id":"one"},{"id":"two"},{"id":"one"}]}"#.to_vec(),
    });
    let mut config = ModelProviderConfig::new(ProviderId::new("custom-test").unwrap());
    config.base_url = Some("https://example.test/v1/".into());
    config.custom = Some(CustomProviderConfig {
        context_window: 272_000,
        order: 0,
        // Keep this discovery fixture independent of inherited built-in model rows.
        model: Some(ModelId::new("catalog-test-model").unwrap()),
        name: "Example".into(),
        protocol: CustomProviderProtocol::Responses,
    });
    let registry = ProviderConfigRegistry::builtin()
        .with_configs([&config])
        .unwrap();
    let credentials = ProviderCredentialService::new(registry.clone(), secrets.clone());
    credentials
        .set_api_key(&config.provider, b"custom-key".to_vec())
        .unwrap();
    let runtime = crate::ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        client.clone(),
        secrets,
    );
    let binding = runtime.catalog_binding(&config).unwrap().unwrap();
    assert!(client.requests.lock().unwrap().is_empty());
    let manager = runtime.models_manager().with_registry(registry);
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(manager.refresh(binding.scope().clone(), binding.source()))
        .unwrap();
    let entries = manager
        .list(&[binding.scope().clone()], &CatalogQuery::all())
        .unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.model().model.as_str())
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url(), "https://example.test/v1/models");
    assert_eq!(requests[0].method(), ash_http_client::HttpMethod::Get);
    assert_eq!(
        requests[0].headers(),
        &[ash_http_client::HttpHeader::new(
            "Authorization",
            "Bearer custom-key"
        )]
    );
    drop(requests);
    credentials
        .set_api_key(&config.provider, b"rotated-key".to_vec())
        .unwrap();
    let changed_key = runtime.catalog_binding(&config).unwrap().unwrap();
    assert_ne!(binding.scope(), changed_key.scope());
    config.custom.as_mut().unwrap().protocol = CustomProviderProtocol::ChatCompletions;
    let changed_protocol = runtime.catalog_binding(&config).unwrap().unwrap();
    assert_ne!(changed_key.scope(), changed_protocol.scope());
    config.base_url = Some("https://other.test/v1".into());
    assert_ne!(
        changed_protocol.scope(),
        runtime.catalog_binding(&config).unwrap().unwrap().scope()
    );
}

#[test]
fn model_discovery_classifies_http_failures_without_exposing_response_bodies() {
    struct Client(u16);
    impl OperationClient for Client {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            Ok(ClientResponse::new(
                self.0,
                vec![],
                b"secret-response".to_vec(),
            ))
        }
    }
    let executor = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    for (status, expected) in [
        (401, CatalogSourceErrorKind::Authentication),
        (403, CatalogSourceErrorKind::Permission),
        (404, CatalogSourceErrorKind::Unsupported),
        (405, CatalogSourceErrorKind::Unsupported),
        (501, CatalogSourceErrorKind::Unsupported),
        (429, CatalogSourceErrorKind::RateLimited),
        (400, CatalogSourceErrorKind::InvalidRequest),
        (503, CatalogSourceErrorKind::ProviderUnavailable),
    ] {
        for provider in ["openai", "ollama"] {
            let runtime =
                crate::ModelProviderRuntime::builtin_with_client(Arc::new(Client(status)));
            let binding = runtime
                .catalog_binding(&ModelProviderConfig::new(
                    ProviderId::new(provider).unwrap(),
                ))
                .unwrap()
                .unwrap();
            let error = executor
                .block_on(
                    runtime
                        .models_manager()
                        .refresh(binding.scope().clone(), binding.source()),
                )
                .unwrap_err();
            assert!(!error.to_string().contains("secret-response"));
            let ash_models_manager::ModelsManagerError::Source { error, .. } = error else {
                panic!("expected source error")
            };
            assert_eq!(error.kind(), expected, "{provider}: {status}");
        }
    }
}

#[test]
fn model_discovery_classifies_client_failures_without_exposing_details() {
    struct Client(ClientError);
    impl OperationClient for Client {
        fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
            Err(self.0.clone())
        }
    }
    let executor = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    for (error, expected) in [
        (
            ClientError::Transport("secret".into()),
            CatalogSourceErrorKind::Unreachable,
        ),
        (
            ClientError::Cancelled("secret".into()),
            CatalogSourceErrorKind::Cancelled,
        ),
        (
            ClientError::InvalidRequest("secret".into()),
            CatalogSourceErrorKind::InvalidRequest,
        ),
        (
            ClientError::InvalidResponse("secret".into()),
            CatalogSourceErrorKind::InvalidPayload,
        ),
        (
            ClientError::Framing("secret".into()),
            CatalogSourceErrorKind::InvalidPayload,
        ),
    ] {
        let runtime = crate::ModelProviderRuntime::builtin_with_client(Arc::new(Client(error)));
        let binding = runtime
            .catalog_binding(&ModelProviderConfig::new(
                ProviderId::new("openai").unwrap(),
            ))
            .unwrap()
            .unwrap();
        let error = executor
            .block_on(
                runtime
                    .models_manager()
                    .refresh(binding.scope().clone(), binding.source()),
            )
            .unwrap_err();
        assert!(!error.to_string().contains("secret"));
        let ash_models_manager::ModelsManagerError::Source { error, .. } = error else {
            panic!("expected source error")
        };
        assert_eq!(error.kind(), expected);
    }
}
