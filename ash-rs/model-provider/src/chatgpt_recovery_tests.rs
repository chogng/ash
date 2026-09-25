use super::*;
use base64::Engine;
use std::sync::atomic::AtomicUsize;

#[derive(Clone, Copy, Eq, PartialEq)]
enum ResponseCase {
    Recover,
    Denied,
    StreamError,
    PartialStream,
    RefreshFailure,
    FollowupTransportFailure,
    FollowupCancelled,
}

struct RecoveryClient {
    calls: Mutex<Vec<String>>,
    attempts: AtomicUsize,
    refreshed_access: String,
    response: ResponseCase,
    during_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl OperationClient for RecoveryClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.calls.lock().unwrap().push(request.url().into());
        if request.url() == "https://auth.openai.com/oauth/token" {
            if self.response == ResponseCase::RefreshFailure {
                return Ok(ClientResponse::new(
                    500,
                    vec![],
                    b"secret refresh body".to_vec(),
                ));
            }
            let body: Value = serde_json::from_slice(request.body()).unwrap();
            assert_eq!(body["grant_type"], "refresh_token");
            return Ok(ClientResponse::new(
                200,
                Vec::new(),
                serde_json::to_vec(
                    &json!({"access_token":self.refreshed_access,"refresh_token":"renewed"}),
                )
                .unwrap(),
            ));
        }
        assert_luna_low(request);
        if let Some(action) = self.during_request.lock().unwrap().take() {
            action();
        }
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
        if attempt > 0 {
            match self.response {
                ResponseCase::FollowupTransportFailure => {
                    return Err(ClientError::Transport("secret transport detail".into()));
                }
                ResponseCase::FollowupCancelled => {
                    return Err(ClientError::Cancelled("cancelled".into()));
                }
                _ => {}
            }
        }
        if attempt == 0 || self.response == ResponseCase::Denied {
            Ok(ClientResponse::new(
                401,
                vec![
                    HttpHeader::new("x-request-id", format!("rejected-{attempt}")),
                    HttpHeader::new("cf-ray", "ray-first"),
                    HttpHeader::new("x-openai-authorization-error", "token_expired"),
                ],
                br#"{"error":{"code":"invalid_api_key"}}"#.to_vec(),
            ))
        } else {
            Ok(ClientResponse::new(
                200,
                Vec::new(),
                serde_json::to_vec(&responses_response("recovered")).unwrap(),
            ))
        }
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        if matches!(
            self.response,
            ResponseCase::StreamError | ResponseCase::PartialStream
        ) {
            self.calls.lock().unwrap().push(request.url().into());
            assert_luna_low(request);
            if self.response == ResponseCase::PartialStream {
                sink.emit(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"already delivered\"}\n\n")?;
            }
            sink.emit(b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"invalid_api_key\",\"message\":\"Authentication failed\"}}}\n\n")?;
            return Ok(ClientResponse::new(200, Vec::new(), Vec::new()));
        }
        let response = self.execute(request)?;
        if !response.is_success() {
            return Ok(response);
        }
        let streamed = StreamingTransport.execute_streaming(request, sink)?;
        Ok(ClientResponse::new(
            streamed.status(),
            vec![HttpHeader::new("x-request-id", "followup-success")],
            streamed.body().to_vec(),
        ))
    }
}

fn assert_luna_low(request: &ClientRequest) {
    let body: Value = serde_json::from_slice(request.body()).unwrap();
    assert_eq!(body["model"], "gpt-5.6-luna");
    assert_eq!(body["reasoning"]["effort"], "low");
    assert_eq!(body["prompt_cache_key"], "recovery-session");
    assert!(
        request
            .headers()
            .iter()
            .any(|header| header.name() == "session-id" && header.value() == "recovery-session")
    );
}

fn request() -> ModelRequest {
    let mut request = ModelRequest::text("hello");
    request.prompt_cache_key = Some("recovery-session".into());
    request.reasoning = Some(ash_protocol::ReasoningConfig {
        effort: ash_protocol::ReasoningEffort::Low,
        summary: false,
    });
    request
}

fn fixture(
    response: ResponseCase,
) -> (
    tempfile::TempDir,
    Arc<RecoveryClient>,
    Arc<dyn ModelInvoker>,
) {
    fixture_with_diagnostics(response, None)
}

fn fixture_with_diagnostics(
    response: ResponseCase,
    diagnostics: Option<Arc<dyn response_debug_context::ResponseDiagnosticSink>>,
) -> (
    tempfile::TempDir,
    Arc<RecoveryClient>,
    Arc<dyn ModelInvoker>,
) {
    let jwt = |value: Value| {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        )
    };
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("auth.json"), serde_json::to_vec(&json!({
        "auth_mode":"chatgpt","OPENAI_API_KEY":null,"last_refresh":"2026-09-07T00:00:00Z",
        "tokens":{"id_token":jwt(json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1"}})),"access_token":jwt(json!({"exp":4_000_000_000_u64,"jti":"old"})),"refresh_token":"old-refresh","account_id":"account-1"}
    })).unwrap()).unwrap();
    let client = Arc::new(RecoveryClient {
        calls: Mutex::new(Vec::new()),
        attempts: AtomicUsize::new(0),
        refreshed_access: jwt(json!({"exp":4_000_000_000_u64,"jti":"new"})),
        response,
        during_request: Mutex::new(None),
    });
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = ChatGptOAuth::with_client(
        home.path().into(),
        secrets.clone(),
        client.clone(),
        ash_chatgpt::ChatGptAuthManagement::Ash,
    );
    let mut runtime = ModelProviderRuntime::with_client_and_secrets(
        ProviderConfigRegistry::builtin(),
        client.clone(),
        secrets,
    )
    .with_chatgpt_oauth(auth);
    if let Some(diagnostics) = diagnostics {
        runtime = runtime.with_response_diagnostics(diagnostics);
    }
    let model = runtime
        .build_model(
            &provider_config("openai"),
            &model_ref("openai", "gpt-5.6-luna"),
        )
        .unwrap();
    (home, client, model)
}

#[test]
fn managed_chatgpt_recovers_one_rejected_request_for_both_consumers() {
    for streaming in [false, true] {
        let (_home, client, model) = fixture(ResponseCase::Recover);
        let response = if streaming {
            model.stream_with_cancellation(
                &request(),
                &CancellationSource::new().token(),
                &mut RecordedModelEvents::default(),
            )
        } else {
            model.invoke(&request())
        }
        .unwrap();
        assert_eq!(response.text(), "live");
        assert_eq!(
            *client.calls.lock().unwrap(),
            vec![
                "https://chatgpt.com/backend-api/codex/responses",
                "https://auth.openai.com/oauth/token",
                "https://chatgpt.com/backend-api/codex/responses",
            ]
        );
    }
}

#[test]
fn chatgpt_never_replays_a_request_as_another_user_in_the_same_workspace() {
    for streaming in [false, true] {
        let (home, client, model) = fixture(ResponseCase::Recover);
        let path = home.path().join("auth.json");
        let access = client.refreshed_access.clone();
        *client.during_request.lock().unwrap() = Some(Box::new(move || {
            let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let identity = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&json!({"https://api.openai.com/auth":{
                    "chatgpt_user_id":"user-2","chatgpt_account_id":"account-1"
                }}))
                .unwrap(),
            );
            value["tokens"]["id_token"] = format!("e30.{identity}.signature").into();
            value["tokens"]["access_token"] = access.into();
            std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }));
        let mut events = RecordedModelEvents::default();
        let result = if streaming {
            model.stream_with_cancellation(
                &request(),
                &CancellationSource::new().token(),
                &mut events,
            )
        } else {
            model.invoke(&request())
        };
        assert!(matches!(result, Err(ModelProviderError::Credential(_))));
        assert!(events.0.is_empty());
        assert_eq!(
            *client.calls.lock().unwrap(),
            vec!["https://chatgpt.com/backend-api/codex/responses"]
        );
    }
}

#[test]
fn chatgpt_stream_with_delivered_output_is_never_replayed() {
    let (home, client, model) = fixture(ResponseCase::PartialStream);
    let before = std::fs::read(home.path().join("auth.json")).unwrap();
    let mut events = RecordedModelEvents::default();
    let result =
        model.stream_with_cancellation(&request(), &CancellationSource::new().token(), &mut events);
    assert!(matches!(result, Err(ModelProviderError::AuthFailed(_))));
    assert_eq!(
        events.0,
        vec![ModelStreamEvent::TextDelta("already delivered".into())]
    );
    assert_eq!(client.calls.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(home.path().join("auth.json")).unwrap(),
        before
    );
}

#[test]
fn chatgpt_accepted_stream_error_without_output_is_not_replayed() {
    let (_home, client, model) = fixture(ResponseCase::StreamError);
    let mut events = RecordedModelEvents::default();
    let result =
        model.stream_with_cancellation(&request(), &CancellationSource::new().token(), &mut events);
    assert!(matches!(result, Err(ModelProviderError::AuthFailed(_))));
    assert!(events.0.is_empty());
    assert_eq!(client.calls.lock().unwrap().len(), 1);
}

#[test]
fn chatgpt_stops_after_one_recovery_attempt() {
    let (_home, client, model) = fixture(ResponseCase::Denied);
    assert!(matches!(
        model.invoke(&request()),
        Err(ModelProviderError::Api(ash_api::ApiError::HttpStatus(401)))
    ));
    assert_eq!(client.calls.lock().unwrap().len(), 3);
    assert!(model.invoke(&request()).is_err());
    assert_eq!(
        client
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.ends_with("/oauth/token"))
            .count(),
        1
    );
}

#[derive(Default)]
struct CapturedDiagnostics(Mutex<Vec<response_debug_context::ResponseDiagnostic>>);

impl response_debug_context::ResponseDiagnosticSink for CapturedDiagnostics {
    fn record_response(&self, diagnostic: response_debug_context::ResponseDiagnostic) {
        self.0.lock().unwrap().push(diagnostic);
    }
}

#[test]
fn recovery_diagnostics_preserve_the_original_401_and_actual_followup() {
    use response_debug_context::AuthHeader;
    use response_debug_context::AuthRecovery;
    use response_debug_context::DiagnosticOutcome;
    use response_debug_context::RequestOutcome;
    for streaming in [false, true] {
        for (case, recovery, outcome, attempts, last) in [
            (
                ResponseCase::Recover,
                AuthRecovery::CredentialsRecovered,
                DiagnosticOutcome::Succeeded,
                2,
                RequestOutcome::Http { status: 200 },
            ),
            (
                ResponseCase::Denied,
                AuthRecovery::CredentialsRecovered,
                DiagnosticOutcome::Failed,
                2,
                RequestOutcome::Http { status: 401 },
            ),
            (
                ResponseCase::RefreshFailure,
                AuthRecovery::Failed,
                DiagnosticOutcome::Failed,
                1,
                RequestOutcome::Http { status: 401 },
            ),
            (
                ResponseCase::FollowupTransportFailure,
                AuthRecovery::CredentialsRecovered,
                DiagnosticOutcome::Failed,
                2,
                RequestOutcome::TransportFailure,
            ),
            (
                ResponseCase::FollowupCancelled,
                AuthRecovery::CredentialsRecovered,
                DiagnosticOutcome::Cancelled,
                2,
                RequestOutcome::Cancelled,
            ),
        ] {
            let diagnostics = Arc::new(CapturedDiagnostics::default());
            let (_home, _client, model) = fixture_with_diagnostics(case, Some(diagnostics.clone()));
            let result = if streaming {
                model.stream_with_cancellation(
                    &request(),
                    &CancellationSource::new().token(),
                    &mut RecordedModelEvents::default(),
                )
            } else {
                model.invoke(&request())
            };
            assert_eq!(result.is_ok(), outcome == DiagnosticOutcome::Succeeded);
            let reports = diagnostics.0.lock().unwrap();
            assert_eq!(reports.len(), 1);
            let report = &reports[0];
            assert_eq!(
                (report.recovery, report.outcome, report.attempts),
                (recovery, outcome, attempts)
            );
            let original = report.first_unauthorized.as_ref().unwrap();
            assert_eq!(original.response.request_id.as_deref(), Some("rejected-0"));
            assert_eq!(original.response.cf_ray.as_deref(), Some("ray-first"));
            assert_eq!(original.auth_headers, vec![AuthHeader::Authorization]);
            assert_eq!(report.first_failure.as_ref(), Some(original));
            assert_eq!(report.latest.as_ref().unwrap().outcome, last);
            if case == ResponseCase::Denied {
                assert_eq!(
                    report
                        .latest
                        .as_ref()
                        .unwrap()
                        .response
                        .request_id
                        .as_deref(),
                    Some("rejected-1")
                );
            }
            let encoded = serde_json::to_string(report).unwrap();
            for secret in [
                "secret",
                "old-refresh",
                "signature",
                "hello",
                "account-1",
                "https://",
            ] {
                assert!(!encoded.contains(secret), "diagnostics leaked {secret}");
            }
        }
    }
}

#[test]
fn accepted_stream_failure_does_not_claim_http_401_or_auth_recovery() {
    for case in [ResponseCase::StreamError, ResponseCase::PartialStream] {
        let diagnostics = Arc::new(CapturedDiagnostics::default());
        let (_home, client, model) = fixture_with_diagnostics(case, Some(diagnostics.clone()));
        assert!(model.invoke(&request()).is_err());
        let reports = diagnostics.0.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(
            reports[0].outcome,
            response_debug_context::DiagnosticOutcome::Failed
        );
        assert!(reports[0].first_unauthorized.is_none());
        assert_eq!(
            reports[0].recovery,
            response_debug_context::AuthRecovery::NotAttempted
        );
        assert_eq!(client.calls.lock().unwrap().len(), 1);
    }
}

#[test]
fn rejected_chatgpt_credentials_block_later_invocations() {
    let diagnostics = Arc::new(CapturedDiagnostics::default());
    let (_home, client, model) =
        fixture_with_diagnostics(ResponseCase::Denied, Some(diagnostics.clone()));
    assert!(model.invoke(&request()).is_err());
    assert!(matches!(
        model.invoke(&request()),
        Err(ModelProviderError::Credential(_))
    ));
    let reports = diagnostics.0.lock().unwrap();
    assert_eq!(reports.len(), 2);
    assert!(reports[0].first_unauthorized.is_some());
    assert_eq!(reports[1].attempts, 0);
    assert_eq!(
        reports[0]
            .first_unauthorized
            .as_ref()
            .unwrap()
            .response
            .request_id
            .as_deref(),
        Some("rejected-0")
    );
    assert!(reports[1].first_unauthorized.is_none());
    assert!(reports[1].latest.is_none());
    assert_eq!(
        reports[1].recovery,
        response_debug_context::AuthRecovery::NotAttempted
    );
    assert_eq!(client.attempts.load(Ordering::SeqCst), 2);
}
