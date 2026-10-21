use ash_async_utils::CancellationToken;
use ash_core::NoThreadWorktreeBinder;
use ash_core::ThreadController;
use ash_core::TurnExecutor;
use ash_model_provider::ModelEventSink;
use ash_model_provider::ModelInvoker;
use ash_model_provider::ModelProviderError;
use ash_protocol::CommandId;
use ash_protocol::ContentDigest;
use ash_protocol::MessageBoundary;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelUsage;
use ash_protocol::ThreadId;
use ash_protocol::TurnStatus;
use core_api::CoreError;
use core_api::ModelSelection;
use core_api::ModelService;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

struct Exchange {
    request: ModelRequest,
    usage: ModelUsage,
    elapsed_ms: u128,
    first_text_us: Option<u64>,
    text_delta_count: u64,
}

struct Luna {
    model: Arc<dyn ModelInvoker>,
    exchanges: Mutex<Vec<Exchange>>,
}

struct ForwardDeltas<'a> {
    sink: &'a mut dyn core_api::ModelStreamSink,
    started: Instant,
    first_text_us: Option<u64>,
    text_delta_count: u64,
}
impl ModelEventSink for ForwardDeltas<'_> {
    fn emit(&mut self, event: ash_protocol::ModelStreamEvent) -> Result<(), ModelProviderError> {
        if matches!(&event, ash_protocol::ModelStreamEvent::TextDelta(text) | ash_protocol::ModelStreamEvent::MessageDelta { text, .. } if !text.is_empty())
        {
            self.first_text_us
                .get_or_insert(self.started.elapsed().as_micros() as u64);
            self.text_delta_count += 1;
        }
        self.sink.emit(event).map_err(|_| {
            ModelProviderError::InvalidResponse("live test stream rejected output".into())
        })
    }
}
struct IgnoreCoreDeltas;
impl core_api::ModelStreamSink for IgnoreCoreDeltas {
    fn emit(&mut self, _: ash_protocol::ModelStreamEvent) -> Result<(), CoreError> {
        Ok(())
    }
}

#[test]
fn manual_compaction_persists_before_restart_and_preserves_the_next_request() {
    struct CompletionObserver(std::sync::mpsc::Sender<core_api::TurnExecutionFinished>);
    impl core_api::TurnExecutionObserver for CompletionObserver {
        fn will_execute(&self, _: &core_api::TurnExecutionStarted) -> Result<(), CoreError> {
            Ok(())
        }

        fn did_finish(&self, event: &core_api::TurnExecutionFinished) {
            self.0.send(event.clone()).unwrap();
        }
    }

    struct ScriptedModel(Mutex<Vec<ModelRequest>>);
    impl ModelService for ScriptedModel {
        fn invoke(
            &self,
            _: ModelSelection<'_>,
            request: &ModelRequest,
            _: &CancellationToken,
        ) -> Result<ModelResponse, CoreError> {
            let mut requests = self.0.lock().unwrap();
            let text = match requests.len() {
                // A real compaction candidate must be longer than its bounded summary.
                0 => "Validate the release candidate, publish, then monitor.\n".repeat(40),
                1 => "Release checkpoint: validate the candidate before publishing.".into(),
                2 => "Start by validating the release candidate.".into(),
                _ => panic!("unexpected extra model invocation"),
            };
            requests.push(request.clone());
            Ok(ModelResponse {
                output: vec![ash_protocol::ResponseItem::Text(text)],
                usage: None,
                billing: None,
                stop_reason: ash_protocol::StopReason::Completed,
            })
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("compaction.sqlite");
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        ash_state::SqliteThreadStore::open(&database).unwrap(),
    )));
    let thread = threads
        .start_thread(
            &NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                execution_target: None,
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new("compaction-thread").unwrap(),
                title: "Release plan".into(),
            },
        )
        .unwrap()
        .thread_id;
    let start_turn = |threads: &ThreadController, key: &str, text: &str| {
        threads
            .start_turn(
                &thread,
                ash_core::StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    command_id: CommandId::new(key).unwrap(),
                    expected_sequence: core_api::SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    kind: Default::default(),
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    policy_revision: "test-policy-v1".into(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: vec![],
                    input: vec![ash_protocol::UserInput::Text { text: text.into() }],
                },
            )
            .unwrap()
            .turn_id
    };
    let model = Arc::new(ScriptedModel(Mutex::new(Vec::new())));
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let observer = Arc::new(CompletionObserver(finished_tx));
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_execution_observer(observer.clone());
    let execute =
        |executor: &TurnExecutor, threads: &ThreadController, turn: &ash_protocol::TurnId| {
            executor.start(&thread, turn).unwrap();
            let finished = finished_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(&finished.turn_id, turn);
            assert_eq!(
                finished.terminal_state,
                core_api::TurnExecutionTerminalState::Completed,
                "turn {turn}: {:?}",
                threads
                    .read_thread(&thread)
                    .unwrap()
                    .turns
                    .last()
                    .unwrap()
                    .failure
            );
        };
    let turn = start_turn(&threads, "plan-release", "Plan the release.");
    execute(&executor, &threads, &turn);
    let compact = threads
        .start_context_compaction(
            &thread,
            ash_core::StartContextCompactionRequest {
                command_id: CommandId::new("compact-release").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: None,
                policy_revision: "test-policy-v1".into(),
                retention_prompt: Some("Preserve the release ordering.".into()),
            },
        )
        .unwrap()
        .turn_id;
    execute(&executor, &threads, &compact);
    let committed = threads.read_thread(&thread).unwrap();
    assert_eq!(committed.context_checkpoints.len(), 1);
    assert_eq!(
        committed.turns.last().unwrap().status,
        TurnStatus::Completed
    );
    drop(executor);
    drop(threads);

    // Reopen the database before any subsequent turn can regenerate context state.
    let store = ash_state::SqliteThreadStore::open(&database).unwrap();
    let events = thread_store::ThreadStore::load(&store, &thread).unwrap();
    assert!(events.iter().any(|record| matches!(
        &record.event,
        ash_protocol::ThreadEvent::ContextCheckpointCommitted { checkpoint, .. }
            if checkpoint == &committed.context_checkpoints[0]
    )));
    let threads = Arc::new(ThreadController::with_store(Arc::new(store)));
    let recovered = threads.read_thread(&thread).unwrap();
    assert_eq!(recovered.context_checkpoints, committed.context_checkpoints);
    assert_eq!(recovered.sequence, committed.sequence);
    let turn = start_turn(
        &threads,
        "continue-release",
        "Continue with the first step.",
    );
    let executor = TurnExecutor::without_tools(threads.clone(), model.clone())
        .with_execution_observer(observer);
    execute(&executor, &threads, &turn);
    let requests = model.0.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let before = serde_json::to_string(&requests[0].input).unwrap();
    let compaction = serde_json::to_string(&requests[1].input).unwrap();
    let continuation = serde_json::to_string(&requests[2].input).unwrap();
    assert!(before.contains("Plan the release."));
    assert!(compaction.contains("Plan the release."));
    assert!(compaction.contains("Preserve the release ordering."));
    assert!(requests[1].tools.is_empty());
    assert_eq!(
        continuation
            .matches("Release checkpoint: validate the candidate before publishing.")
            .count(),
        1
    );
    assert!(!continuation.contains("Plan the release."));
    assert!(continuation.contains("Continue with the first step."));
    assert!(
        requests[2]
            .instructions
            .as_ref()
            .unwrap()
            .contains(ash_prompts::AGENT_INSTRUCTIONS.body())
    );
    assert_eq!(
        threads
            .read_thread(&thread)
            .unwrap()
            .context_checkpoints
            .len(),
        1
    );
}

impl ModelService for Luna {
    fn output_transport(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ash_protocol::ModelOutputTransport, CoreError> {
        Ok(self.model.output_transport())
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        self.stream(
            ModelSelection::ConfiguredDefault,
            request,
            cancellation,
            &mut IgnoreCoreDeltas,
        )
    }

    fn stream(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn core_api::ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        let mut request = request.clone();
        request.reasoning = Some(ash_protocol::ReasoningConfig {
            effort: ash_protocol::ReasoningEffort::Low,
            summary: false,
        });
        let started = Instant::now();
        let mut observer = ForwardDeltas {
            sink,
            started,
            first_text_us: None,
            text_delta_count: 0,
        };
        let response = self
            .model
            .stream_with_cancellation(&request, cancellation, &mut observer)
            .map_err(|_| {
                CoreError::Model("Luna live request failed; no provider details are logged".into())
            })?;
        let usage = response
            .usage
            .clone()
            .ok_or_else(|| CoreError::Model("Luna returned no token usage".into()))?;
        self.exchanges.lock().unwrap().push(Exchange {
            request,
            usage,
            elapsed_ms: started.elapsed().as_millis(),
            first_text_us: observer.first_text_us,
            text_delta_count: observer.text_delta_count,
        });
        Ok(response)
    }
}

struct ReadOnlyAuth;
impl ash_client::OperationClient for ReadOnlyAuth {
    fn execute(
        &self,
        _: &ash_client::ClientRequest,
    ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
        Err(ash_client::ClientError::Transport(
            "live tests cannot refresh authentication".into(),
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
struct CacheRoutingIdentity {
    account_fingerprint: String,
    session_id: String,
    prompt_cache_key: String,
    request_prefix_fingerprint: String,
}

struct ObserveCacheRouting {
    client: ash_client::AshClient,
    identities: Arc<Mutex<Vec<CacheRoutingIdentity>>>,
    usages: Arc<Mutex<Vec<serde_json::Value>>>,
}

struct ObserveCacheUsage<'a> {
    sink: &'a mut dyn ash_client::OperationStreamSink,
    decoder: ash_client::SseDecoder,
    usages: &'a Mutex<Vec<serde_json::Value>>,
}

impl ash_client::OperationStreamSink for ObserveCacheUsage<'_> {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), ash_client::ClientError> {
        for frame in self.decoder.push(chunk)? {
            let ash_client::SseFrame::Event(event) = frame else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.data) else {
                continue;
            };
            if payload["type"] == "response.completed" {
                // Preserve only usage counters from the wire, independently of Ash's decoder.
                // Response text, encrypted content, and credentials never enter the evidence.
                let mut usage = payload["response"]["usage"].clone();
                usage.as_object_mut().unwrap().remove("attribution");
                self.usages.lock().unwrap().push(usage);
            }
        }
        self.sink.emit(chunk)
    }
}

impl ash_client::OperationClient for ObserveCacheRouting {
    fn execute(
        &self,
        _: &ash_client::ClientRequest,
    ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
        Err(ash_client::ClientError::InvalidRequest(
            "cache probe only sends Responses streams".into(),
        ))
    }

    fn execute_streaming_with_cancellation(
        &self,
        request: &ash_client::ClientRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ash_client::OperationStreamSink,
    ) -> Result<ash_client::ClientResponse, ash_client::ClientError> {
        assert_eq!(
            request.url(),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        let header = |name: &str| {
            let values = request
                .headers()
                .iter()
                .filter(|header| header.name().eq_ignore_ascii_case(name))
                .map(|header| header.value())
                .collect::<Vec<_>>();
            assert_eq!(values.len(), 1, "expected one {name} header");
            values[0]
        };
        assert!(header("authorization").starts_with("Bearer "));
        let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(body["model"], "gpt-5.6-luna");
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert!(body.get("prompt_cache_options").is_none());
        assert!(body.get("prompt_cache_retention").is_none());
        let prefix = serde_json::json!({
            "model":body["model"],
            "instructions":body["instructions"],
            "firstInputItem":body["input"][0],
            "reasoning":body["reasoning"],
            "tools":body["tools"],
            "toolChoice":body["tool_choice"],
            "parallelToolCalls":body["parallel_tool_calls"],
            "text":body["text"]
        });
        // Observe the production request unchanged. Retain only an account digest, never tokens.
        let identity = CacheRoutingIdentity {
            account_fingerprint: ContentDigest::sha256(header("chatgpt-account-id").as_bytes())
                .to_string(),
            session_id: header("session-id").to_owned(),
            prompt_cache_key: body["prompt_cache_key"].as_str().unwrap().to_owned(),
            request_prefix_fingerprint: ContentDigest::sha256(
                &serde_json::to_vec(&prefix).unwrap(),
            )
            .to_string(),
        };
        assert_eq!(identity.session_id, identity.prompt_cache_key);
        self.identities.lock().unwrap().push(identity);
        let mut observer = ObserveCacheUsage {
            sink,
            decoder: ash_client::SseDecoder::new(1024 * 1024)?,
            usages: &self.usages,
        };
        self.client
            .execute_streaming_with_cancellation(request, cancellation, &mut observer)
    }
}

fn auth_fingerprint(home: &Path) -> Option<ContentDigest> {
    match std::fs::read(home.join("auth.json")) {
        Ok(bytes) => Some(ContentDigest::sha256(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => panic!("cannot fingerprint Codex authentication"),
    }
}

fn model_ref() -> ModelRef {
    ModelRef {
        provider: ash_protocol::ProviderId::new("openai").unwrap(),
        model: ash_protocol::ModelId::new("gpt-5.6-luna").unwrap(),
    }
}

fn run(
    threads: &ThreadController,
    executor: &TurnExecutor,
    thread: &ThreadId,
    label: &str,
    prompt: String,
) -> ash_core::ThreadSnapshot {
    let turn = threads
        .start_turn(
            thread,
            ash_core::StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                command_id: CommandId::new(label).unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: Some(model_ref()),
                reasoning_effort: None,
                kind: Default::default(),
                instructions: ash_protocol::TurnInstructions::new(
                    "live-cache-test",
                    "live-cache-test",
                    "1",
                    "This is a synthetic cache test. Reply with exactly ACK. Do not use tools.",
                )
                .unwrap(),
                policy_revision: "test".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![ash_protocol::UserInput::Text { text: prompt }],
            },
        )
        .unwrap();
    executor.start(thread, &turn.turn_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let snapshot = threads.read_thread(thread).unwrap();
        let current = snapshot
            .turns
            .iter()
            .find(|candidate| candidate.turn_id == turn.turn_id)
            .unwrap();
        if matches!(
            current.status,
            TurnStatus::Completed | TurnStatus::Interrupted | TurnStatus::Failed
        ) {
            assert_eq!(
                current.status,
                TurnStatus::Completed,
                "Luna case {label} failed: {:?}",
                current.failure.as_ref().map(|error| &error.code)
            );
            assert!(
                matches!(snapshot.items.iter().rev().find(|item| item.turn_id() == &turn.turn_id), Some(ash_protocol::ThreadItem::AgentMessage { text, .. }) if text.trim() == "ACK")
            );
            return snapshot;
        }
        if Instant::now() >= deadline {
            threads
                .interrupt_turn(
                    thread,
                    core_api::InterruptTurnRequest {
                        command_id: CommandId::new(format!("cancel-{label}")).unwrap(),
                        expected_sequence: core_api::SequenceExpectation::Any,
                        turn_id: turn.turn_id.clone(),
                    },
                )
                .unwrap();
            panic!("Luna case {label} timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "Live Luna / low only; three synthetic requests and a complete local runtime reopen"]
fn luna_cache_and_routing_identity_survive_same_thread_restart() {
    let exchanges = observe_luna_usage_after_same_thread_restart();
    assert!(
        exchanges[1..].iter().all(|exchange| exchange
            .usage
            .cached_input_tokens
            .is_some_and(|tokens| tokens > 0)),
        "continuation or resumed conversation missed cache; inspect LUNA_RESUME measurements"
    );
}

#[test]
#[ignore = "Live Luna / low only; three synthetic requests compare wire usage with persisted totals"]
fn luna_usage_matches_wire_and_persisted_totals_after_restart() {
    observe_luna_usage_after_same_thread_restart();
}

fn observe_luna_usage_after_same_thread_restart() -> Vec<Exchange> {
    let home = ash_chatgpt::codex_home().unwrap();
    let fingerprint = auth_fingerprint(&home);
    let identities = Arc::new(Mutex::new(Vec::new()));
    let wire_usages = Arc::new(Mutex::new(Vec::new()));
    let build_model = || {
        let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
        let auth = ash_chatgpt::ChatGptOAuth::with_client(
            home.clone(),
            secrets.clone(),
            Arc::new(ReadOnlyAuth),
            ash_chatgpt::ChatGptAuthManagement::Codex,
        );
        let runtime = ash_model_provider::ModelProviderRuntime::with_client_and_secrets(
            model_provider_info::ProviderConfigRegistry::builtin(),
            Arc::new(ObserveCacheRouting {
                client: ash_client::AshClient::new(Arc::new(
                    ash_http_client::UreqHttpClient::new().unwrap(),
                )),
                identities: identities.clone(),
                usages: wire_usages.clone(),
            }),
            secrets,
        )
        .with_chatgpt_oauth(auth);
        Arc::new(Luna {
            model: runtime
                .build_model(
                    &model_provider_info::ModelProviderConfig::for_connection(
                        ash_protocol::ModelConnectionId::new(
                            ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID,
                        )
                        .unwrap(),
                    ),
                    &model_ref(),
                )
                .unwrap(),
            exchanges: Mutex::new(Vec::new()),
        })
    };
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    let open_threads = || {
        Arc::new(ThreadController::with_store(Arc::new(
            ash_state::SqliteThreadStore::open(&database).unwrap(),
        )))
    };
    let threads = open_threads();
    let luna = build_model();
    let executor = TurnExecutor::without_tools(threads.clone(), luna.clone());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = threads
        .start_thread(
            &NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                execution_target: None,
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new(format!("luna-resume-{nonce}")).unwrap(),
                title: "Synthetic same-thread cache resume".into(),
            },
        )
        .unwrap();
    let corpus = (0..400).map(|index| format!("Record {index:03}: the copper archive stores a green tile, two paper maps, and a numbered wooden box.\n")).collect::<String>();
    run(
        &threads,
        &executor,
        &root.thread_id,
        "seed",
        format!("Fixture {nonce}. Read this synthetic reference and reply ACK.\n{corpus}"),
    );
    let continued = run(
        &threads,
        &executor,
        &root.thread_id,
        "continue",
        "Continue this conversation; reply ACK.".into(),
    );
    let mut exchanges = std::mem::take(&mut *luna.exchanges.lock().unwrap());
    // Discard model/auth/HTTP state as well as the loaded history. Only SQLite and observations
    // cross this boundary, so a hit after reopening cannot rely on a retained model connection.
    drop(executor);
    drop(threads);
    drop(luna);
    let threads = open_threads();
    let restored = threads.read_thread(&root.thread_id).unwrap();
    assert_eq!(restored.thread_id, root.thread_id);
    assert_eq!(restored.session_id, root.session_id);
    assert_eq!(restored.items, continued.items);
    assert_eq!(restored.usage, continued.usage);
    let luna = build_model();
    let executor = TurnExecutor::without_tools(threads.clone(), luna.clone());
    let resumed = run(
        &threads,
        &executor,
        &root.thread_id,
        "resume",
        "Resume this conversation after reopening history; reply ACK.".into(),
    );
    exchanges.append(&mut luna.exchanges.lock().unwrap());
    assert!(
        fingerprint == auth_fingerprint(&home),
        "Codex credentials must remain unchanged"
    );
    let store = ash_state::SqliteThreadStore::open(&database).unwrap();
    let records = thread_store::ThreadStore::load(&store, &root.thread_id)
        .unwrap()
        .into_iter()
        .filter_map(|event| match event.event {
            ash_protocol::ThreadEvent::ModelInvocationRecorded { record, .. } => Some(record),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(records.len(), exchanges.len());
    for (record, exchange) in records.iter().zip(&exchanges) {
        let timing = record
            .timing
            .as_ref()
            .expect("new model calls persist client timing");
        assert_eq!(timing.text_delta_count, exchange.text_delta_count);
        assert!(timing.text_delta_count > 0);
        assert!(timing.first_text_us.unwrap() <= timing.total_us);
        assert!(
            timing
                .first_text_us
                .unwrap()
                .abs_diff(exchange.first_text_us.unwrap())
                < 250_000
        );
        assert!(timing.total_us.abs_diff(exchange.elapsed_ms as u64 * 1000) < 250_000);
        eprintln!(
            "LUNA_TIMING {}",
            serde_json::json!({"invocationId":record.invocation_id,"timing":timing,"usage":record.usage,"independentFirstTextUs":exchange.first_text_us,"independentTotalMs":exchange.elapsed_ms,"independentTextDeltas":exchange.text_delta_count})
        );
    }
    drop(store);
    let identities = identities.lock().unwrap();
    let wire_usages = wire_usages.lock().unwrap();
    assert_eq!(exchanges.len(), 3);
    assert_eq!(identities.len(), exchanges.len());
    assert_eq!(wire_usages.len(), exchanges.len());
    for (((label, exchange), identity), wire) in ["seed", "continue", "resume"]
        .into_iter()
        .zip(&exchanges)
        .zip(identities.iter())
        .zip(wire_usages.iter())
    {
        eprintln!(
            "LUNA_RESUME {}",
            serde_json::json!({"case":label,"threadId":root.thread_id,"sessionId":root.session_id,"routing":identity,"inputTokens":exchange.usage.input_tokens,"cachedTokens":exchange.usage.cached_input_tokens,"cacheWriteTokens":exchange.usage.cache_write_input_tokens,"outputTokens":exchange.usage.output_tokens,"reasoningTokens":exchange.usage.reasoning_tokens,"rawUsage":wire,"elapsedMs":exchange.elapsed_ms})
        );
        for (normalized, pointer) in [
            (exchange.usage.input_tokens, "/input_tokens"),
            (exchange.usage.output_tokens, "/output_tokens"),
            (
                exchange.usage.cached_input_tokens,
                "/input_tokens_details/cached_tokens",
            ),
            (
                exchange.usage.cache_write_input_tokens,
                "/input_tokens_details/cache_write_tokens",
            ),
            (
                exchange.usage.reasoning_tokens,
                "/output_tokens_details/reasoning_tokens",
            ),
        ] {
            assert_eq!(
                normalized,
                wire.pointer(pointer).and_then(serde_json::Value::as_u64)
            );
        }
        assert_eq!(
            wire["total_tokens"].as_u64(),
            Some(wire["input_tokens"].as_u64().unwrap() + wire["output_tokens"].as_u64().unwrap())
        );
        assert_eq!(identity, &identities[0]);
        assert_eq!(identity.session_id, root.session_id.as_str());
        assert_eq!(
            exchange.request.prompt_cache_key.as_deref(),
            Some(identity.prompt_cache_key.as_str())
        );
    }
    assert_eq!(resumed.usage.model_invocations, 3);
    for (metric, pointer) in [
        (&resumed.usage.input_tokens, "/input_tokens"),
        (&resumed.usage.output_tokens, "/output_tokens"),
        (
            &resumed.usage.cached_input_tokens,
            "/input_tokens_details/cached_tokens",
        ),
        (
            &resumed.usage.cache_write_input_tokens,
            "/input_tokens_details/cache_write_tokens",
        ),
        (
            &resumed.usage.reasoning_tokens,
            "/output_tokens_details/reasoning_tokens",
        ),
    ] {
        let values = wire_usages
            .iter()
            .map(|wire| wire.pointer(pointer).and_then(serde_json::Value::as_u64))
            .collect::<Vec<_>>();
        assert_eq!(metric.reported, values.iter().flatten().sum::<u64>());
        assert_eq!(metric.complete, values.iter().all(Option::is_some));
    }
    eprintln!(
        "LUNA_ACCOUNTING {}",
        serde_json::to_string(&resumed.usage).unwrap()
    );
    exchanges
}

#[test]
#[ignore = "Live Luna / low only; six synthetic requests using read-only Codex credentials"]
fn luna_cache_survives_fork_and_message_restore_after_restart() {
    let home = ash_chatgpt::codex_home().unwrap();
    let fingerprint = auth_fingerprint(&home);
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    let auth = ash_chatgpt::ChatGptOAuth::with_client(
        home.clone(),
        secrets.clone(),
        Arc::new(ReadOnlyAuth),
        ash_chatgpt::ChatGptAuthManagement::Codex,
    );
    let runtime = ash_model_provider::ModelProviderRuntime::with_secrets(
        model_provider_info::ProviderConfigRegistry::builtin(),
        secrets,
    )
    .with_chatgpt_oauth(auth);
    let luna = Arc::new(Luna {
        model: runtime
            .build_model(
                &model_provider_info::ModelProviderConfig::new(model_ref().provider),
                &model_ref(),
            )
            .unwrap(),
        exchanges: Mutex::new(Vec::new()),
    });
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        ash_state::SqliteThreadStore::open(&database).unwrap(),
    )));
    let executor = TurnExecutor::without_tools(threads.clone(), luna.clone());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = threads
        .start_thread(
            &NoThreadWorktreeBinder,
            core_api::StartThreadRequest {
                execution_target: None,
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new(format!("luna-cache-{nonce}")).unwrap(),
                title: "Synthetic Luna cache test".into(),
            },
        )
        .unwrap();
    let corpus = (0..640).map(|index| format!("Record {index:03}: the copper archive stores a green tile, two paper maps, and a numbered wooden box.\n")).collect::<String>();
    let seed = run(
        &threads,
        &executor,
        &root.thread_id,
        "seed",
        format!("Fixture {nonce}. Read this synthetic reference and reply ACK.\n{corpus}"),
    );
    let point = threads
        .message_checkpoints(&root.thread_id)
        .unwrap()
        .pop()
        .unwrap();
    let fork = threads
        .fork_thread(
            &NoThreadWorktreeBinder,
            core_api::ForkThreadRequest {
                command_id: CommandId::new("fork").unwrap(),
                source_thread_id: root.thread_id.clone(),
                title: "Fork".into(),
            },
        )
        .unwrap();
    assert_eq!(fork.items, seed.items);
    run(
        &threads,
        &executor,
        &root.thread_id,
        "parent",
        "Parent continuation; reply ACK.".into(),
    );
    run(
        &threads,
        &executor,
        &fork.thread_id,
        "fork",
        "Fork continuation; reply ACK.".into(),
    );
    drop(executor);
    drop(threads);
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        ash_state::SqliteThreadStore::open(&database).unwrap(),
    )));
    let executor = TurnExecutor::without_tools(threads.clone(), luna.clone());
    for (label, boundary) in [
        ("restore-after", MessageBoundary::After),
        ("restore-before", MessageBoundary::Before),
    ] {
        let restored = threads
            .restore_message(
                &NoThreadWorktreeBinder,
                core_api::RestoreMessageRequest {
                    command_id: CommandId::new(label).unwrap(),
                    source_thread_id: fork.thread_id.clone(),
                    item_id: point.item_id.clone(),
                    boundary,
                    title: label.into(),
                },
            )
            .unwrap();
        assert_eq!(restored.agent_id, root.agent_id);
        assert_eq!(restored.session_id, root.session_id);
        assert_eq!(
            restored.items.len(),
            if boundary == MessageBoundary::After {
                2
            } else {
                1
            }
        );
        run(
            &threads,
            &executor,
            &restored.thread_id,
            label,
            format!("{label} continuation; reply ACK."),
        );
    }
    let identical = luna.exchanges.lock().unwrap()[0].request.clone();
    luna.invoke(
        ModelSelection::ConfiguredDefault,
        &identical,
        &ash_async_utils::CancellationSource::new().token(),
    )
    .unwrap();
    assert!(
        fingerprint == auth_fingerprint(&home),
        "Codex credentials must remain unchanged"
    );
    let exchanges = luna.exchanges.lock().unwrap();
    assert_eq!(
        exchanges.len(),
        6,
        "five branch requests and one identical-request control are expected"
    );
    let end = exchanges[1].request.prompt_cache_prefix_end.unwrap() as usize;
    for exchange in &exchanges[2..4] {
        assert_eq!(
            exchange.request.prompt_cache_key,
            exchanges[0].request.prompt_cache_key
        );
        assert_eq!(
            exchange.request.instructions,
            exchanges[1].request.instructions
        );
        assert_eq!(
            exchange.request.input[..=end],
            exchanges[1].request.input[..=end]
        );
    }
    for (label, exchange) in [
        "seed",
        "parent",
        "fork",
        "restore-after",
        "restore-before",
        "identical-control",
    ]
    .into_iter()
    .zip(exchanges.iter())
    {
        eprintln!(
            "LUNA_CACHE {}",
            serde_json::json!({"case":label,"inputTokens":exchange.usage.input_tokens,"cachedTokens":exchange.usage.cached_input_tokens,"cacheWriteTokens":exchange.usage.cache_write_input_tokens,"outputTokens":exchange.usage.output_tokens,"elapsedMs":exchange.elapsed_ms})
        );
    }
    // Hits are an observation from this run, not a universal promise about provider routing.
    assert!(
        exchanges[2..].iter().all(|exchange| exchange
            .usage
            .cached_input_tokens
            .is_some_and(|tokens| tokens > 0)),
        "a branch did not report a cache hit; inspect the LUNA_CACHE measurements"
    );
}
