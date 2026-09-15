use ash_async_utils::CancellationToken;
use ash_model_provider::ModelEventSink;
use ash_model_provider::ModelInvoker;
use ash_model_provider::ModelProviderError;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use core_api::CoreError;
use core_api::ModelSelection;
use core_api::ModelService;
use serde_json::json;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

struct ReadOnlyAuth;
impl ash_client::OperationClient for ReadOnlyAuth {
    fn execute(
        &self,
        _: &ash_client::ClientRequest,
    ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
        Err(ash_client::ClientError::Transport(
            "Live memory tests do not refresh authentication".into(),
        ))
    }
}
struct IgnoreDeltas;
impl ModelEventSink for IgnoreDeltas {
    fn emit(&mut self, _: ash_protocol::ModelStreamEvent) -> Result<(), ModelProviderError> {
        Ok(())
    }
}
struct LiveModel {
    model: Arc<dyn ModelInvoker>,
    requests: Mutex<Vec<ModelRequest>>,
}
impl ModelService for LiveModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let mut request = request.clone();
        request.reasoning = Some(ash_protocol::ReasoningConfig {
            effort: ash_protocol::ReasoningEffort::Low,
            summary: false,
        });
        self.requests.lock().unwrap().push(request.clone());
        self.model
            .stream_with_cancellation(&request, cancellation, &mut IgnoreDeltas)
            .map_err(|error| {
                let category = match error {
                    ModelProviderError::InvalidRequest(message) => {
                        format!("invalid request: {message}")
                    }
                    ModelProviderError::AuthFailed(_) => "authentication failed".into(),
                    ModelProviderError::Credential(_) => "credential unavailable".into(),
                    ModelProviderError::ConfigurationMissing => "configuration missing".into(),
                    ModelProviderError::Api(_) => "API request failed".into(),
                    _ => "model response failed".into(),
                };
                eprintln!("Live memory acceptance: {category}");
                CoreError::Model(format!("Live memory provider: {category}"))
            })
    }
}

#[test]
#[ignore = "Live provider acceptance; uses existing read-only authentication and isolated synthetic memories"]
fn memories_live_model_saves_and_recalls_an_authorized_fact() {
    let home = ash_chatgpt::codex_home().expect("Authentication home unavailable");
    let before = std::fs::read(home.join("auth.json"))
        .map(|bytes| ash_protocol::ContentDigest::sha256(&bytes))
        .expect("Saved authentication is required for live model acceptance");
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    let auth = ash_chatgpt::ChatGptOAuth::with_client(
        home.clone(),
        secrets.clone(),
        Arc::new(ReadOnlyAuth),
        ash_chatgpt::ChatGptAuthManagement::Codex,
    );
    let runtime = ash_model_provider::ModelProviderRuntime::with_secrets(
        ash_model_provider_config::ProviderConfigRegistry::builtin(),
        secrets,
    )
    .with_chatgpt_oauth(auth);
    let model_ref = ash_protocol::ModelRef {
        provider: ash_protocol::ProviderId::new("openai").unwrap(),
        model: ash_protocol::ModelId::new("gpt-5.6-luna").unwrap(),
    };
    let model = Arc::new(LiveModel {
        model: runtime
            .build_model(
                &ash_model_provider_config::ModelProviderConfig::new(model_ref.provider.clone()),
                &model_ref,
            )
            .map_err(|_| "Live model initialization failed")
            .unwrap(),
        requests: Mutex::new(Vec::new()),
    });
    let root = tempfile::tempdir().unwrap();
    let server = super::server_with_model(model.clone())
        .with_local_memories(&root.path().join("state.sqlite"))
        .unwrap();
    let mut host = server.product_host_connection();
    super::initialize(&server, &mut host);
    let session = super::create_session(&server, &mut host, 2, "memory-live")["result"]["session"]
        ["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = super::create_thread(&server, &mut host, 3, "memory-live", &session, 0)["result"]
        ["value"]["threadId"]
        .as_str()
        .unwrap()
        .to_owned();
    let enabled = super::call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0","id":4,"method":"memory/policy/update","params":{"commandId":"enable","scope":{"type":"profile"},"expectedRevision":0,"automaticRead":"firstInvocation","modelWrite":"enabled"}}),
    );
    assert!(
        enabled.get("error").is_none(),
        "Memory consent was not enabled"
    );
    let run = |host: &mut crate::ConnectionState, id: u64, prompt: &str| {
        let thread_id = ash_protocol::ThreadId::new(&thread).unwrap();
        let sequence = server.threads().read_thread(&thread_id).unwrap().sequence;
        let started = super::call(
            &server,
            host,
            json!({"jsonrpc":"2.0","id":id,"method":"session/request","params":{"commandId":format!("turn-{id}"),"sessionId":session,"request":{"type":"startTurn","threadId":thread,"expectedSequence":sequence,"input":[{"type":"text","text":prompt}],"toolMode":"direct"}}}),
        );
        assert!(started.get("error").is_none(), "Live Turn was not accepted");
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let snapshot = server.threads().read_thread(&thread_id).unwrap();
            let current = snapshot.turns.last().unwrap();
            if current.status == ash_protocol::TurnStatus::Completed {
                return snapshot;
            }
            assert!(
                !matches!(
                    current.status,
                    ash_protocol::TurnStatus::Failed | ash_protocol::TurnStatus::Interrupted
                ),
                "Live Turn failed: {:?}",
                current.failure.as_ref().map(|error| &error.code)
            );
            assert!(Instant::now() < deadline, "Live memory Turn timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    run(
        &mut host,
        5,
        "This is an isolated synthetic acceptance test. My durable preference for future tests is: Use cobalt blue fixtures. Please acknowledge briefly. This fixture contains no real project data.",
    );
    let saved = super::call(
        &server,
        &mut host,
        json!({"jsonrpc":"2.0","id":6,"method":"memory/search","params":{"scope":{"type":"profile"},"query":"cobalt"}}),
    );
    assert_eq!(
        saved["result"]["matches"].as_array().map(Vec::len),
        Some(1),
        "The live model did not persist the synthetic fact"
    );
    assert_eq!(
        saved["result"]["matches"][0]["source"]["model"]["threadId"],
        thread
    );
    let snapshot = run(
        &mut host,
        7,
        "What colour should synthetic test fixtures use? Answer briefly from the saved preference.",
    );
    assert!(
        snapshot
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                ash_protocol::ThreadItem::AgentMessage { text, .. } =>
                    Some(text.to_lowercase().contains("cobalt")),
                _ => None,
            })
            .unwrap_or(false)
    );
    assert!(model.requests.lock().unwrap().iter().any(|request| {
        let text = serde_json::to_string(request).unwrap();
        text.contains("context_evidence") && text.contains("cobalt")
    }));
    assert_eq!(
        std::fs::read(home.join("auth.json"))
            .map(|bytes| ash_protocol::ContentDigest::sha256(&bytes))
            .unwrap(),
        before,
        "Live test changed saved authentication"
    );
    eprintln!(
        "Live memory save and recall passed ({} model invocations)",
        model.requests.lock().unwrap().len()
    );
}
