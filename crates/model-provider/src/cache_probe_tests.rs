use super::*;
use ash_client::AshClient;
use ash_client::SseDecoder;
use ash_client::SseFrame;
use ash_http_client::UreqHttpClient;
use ash_protocol::ContentDigest;
use std::time::Instant;

#[derive(Clone, Copy, Debug)]
enum Scope {
    WithoutSessionHeader,
    Production,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CacheUsage {
    input: Option<u64>,
    cached: Option<u64>,
    written: Option<u64>,
}

struct Probe {
    client: AshClient,
    scope: Scope,
    wire_usage: Mutex<Option<CacheUsage>>,
}

struct Observe<'a> {
    inner: &'a mut dyn OperationStreamSink,
    decoder: SseDecoder,
    usage: &'a Mutex<Option<CacheUsage>>,
}

impl OperationStreamSink for Observe<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ClientError> {
        for frame in self.decoder.push(chunk)? {
            let SseFrame::Event(event) = frame else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
                continue;
            };
            if value["type"] == "response.completed" {
                let response = &value["response"];
                assert_eq!(response["model"].as_str(), Some("gpt-5.6-luna"));
                *self.usage.lock().unwrap() = Some(CacheUsage {
                    input: response
                        .pointer("/usage/input_tokens")
                        .and_then(Value::as_u64),
                    cached: response
                        .pointer("/usage/input_tokens_details/cached_tokens")
                        .and_then(Value::as_u64),
                    written: response
                        .pointer("/usage/input_tokens_details/cache_write_tokens")
                        .and_then(Value::as_u64),
                });
            }
        }
        self.inner.emit(chunk)
    }
}

impl OperationClient for Probe {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Err(ClientError::InvalidRequest(
            "probe only sends Responses streams".into(),
        ))
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &ash_async_utils::CancellationToken,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        let body: Value = serde_json::from_slice(request.body()).unwrap();
        let scopes = request
            .headers()
            .iter()
            .filter(|header| header.name().eq_ignore_ascii_case("session-id"))
            .map(|header| header.value())
            .collect::<Vec<_>>();
        assert_eq!(scopes, vec![body["prompt_cache_key"].as_str().unwrap()]);
        // The control removes only the production header. The body remains byte-for-byte equal.
        let request = match self.scope {
            Scope::Production => request.clone(),
            Scope::WithoutSessionHeader => ClientRequest::new(
                request.method(),
                request.url(),
                request
                    .headers()
                    .iter()
                    .filter(|header| !header.name().eq_ignore_ascii_case("session-id"))
                    .cloned()
                    .collect(),
                request.body().to_vec(),
                request.retry_policy(),
            )?,
        };
        *self.wire_usage.lock().unwrap() = None;
        let mut observed = Observe {
            inner: sink,
            decoder: SseDecoder::new(1024 * 1024)?,
            usage: &self.wire_usage,
        };
        self.client
            .execute_streaming_with_cancellation(&request, cancellation, &mut observed)
    }
}

#[test]
#[ignore = "Live Luna / low only; six synthetic requests compare the Session routing header"]
fn live_luna_cache_requires_session_routing_header() {
    let home = ash_chatgpt::codex_home().unwrap();
    let fingerprint = || {
        std::fs::read(home.join("auth.json"))
            .ok()
            .map(|bytes| ContentDigest::sha256(&bytes))
    };
    let before = fingerprint();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let corpus = (0..400).map(|index| format!("Record {index:03}: the copper archive stores a green tile, two paper maps, and a numbered wooden box.\n")).collect::<String>();
    for scope in [Scope::WithoutSessionHeader, Scope::Production] {
        let identity = format!("thread:luna-scope-{nonce}-{scope:?}");
        let client = Arc::new(Probe {
            client: AshClient::new(Arc::new(UreqHttpClient::new().unwrap())),
            scope,
            wire_usage: Mutex::new(None),
        });
        let secrets = Arc::new(MemorySecretStore::default());
        let auth = ChatGptOAuth::with_client(
            home.clone(),
            secrets.clone(),
            Arc::new(FailingTransport),
            ash_chatgpt::ChatGptAuthManagement::Codex,
        );
        let runtime = ModelProviderRuntime::with_client_and_secrets(
            ProviderConfigRegistry::builtin(),
            client.clone(),
            secrets,
        )
        .with_chatgpt_oauth(auth);
        let model = runtime
            .build_model(
                &provider_config("openai"),
                &model_ref("openai", "gpt-5.6-luna"),
            )
            .unwrap();
        let mut request = ModelRequest::text(format!(
            "Fixture {identity}. Read this synthetic reference and reply ACK.\n{corpus}"
        ));
        request.instructions = Some(
            "This is a synthetic cache test. Reply with exactly ACK. Do not use tools.".into(),
        );
        request.reasoning = Some(ash_protocol::ReasoningConfig {
            effort: ash_protocol::ReasoningEffort::Low,
            summary: false,
        });
        request.prompt_cache_key = Some(identity);
        let mut hits = Vec::new();
        for attempt in 1..=3 {
            let started = Instant::now();
            let response = model.stream_with_cancellation(
                &request,
                &CancellationSource::new().token(),
                &mut RecordedModelEvents::default(),
            );
            assert!(
                before == fingerprint(),
                "Codex authentication must remain unchanged"
            );
            assert!(
                response.is_ok(),
                "Luna / low request failed; no provider details are logged"
            );
            let response = response.unwrap();
            assert_eq!(response.text().trim(), "ACK");
            let usage = response.usage.unwrap();
            let measured = CacheUsage {
                input: usage.input_tokens,
                cached: usage.cached_input_tokens,
                written: usage.cache_write_input_tokens,
            };
            assert_eq!(
                Some(&measured),
                client.wire_usage.lock().unwrap().as_ref(),
                "normalized usage must agree with the actual SSE response"
            );
            eprintln!(
                "LUNA_SCOPE {}",
                json!({"scope":format!("{scope:?}"),"attempt":attempt,"input":measured.input,"cached":measured.cached,"written":measured.written,"elapsedMs":started.elapsed().as_millis()})
            );
            hits.push(measured.cached.expect("Luna must report cached tokens"));
        }
        match scope {
            Scope::WithoutSessionHeader => assert!(
                hits.iter().all(|tokens| *tokens == 0),
                "unscoped control reported a cache hit; re-evaluate the observed routing behavior"
            ),
            Scope::Production => assert!(
                hits[1..].iter().any(|tokens| *tokens > 0),
                "scoped repeat did not hit cache; inspect LUNA_SCOPE measurements"
            ),
        }
    }
}
