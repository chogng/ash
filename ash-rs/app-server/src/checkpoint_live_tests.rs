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
}

struct Luna {
    model: Arc<dyn ModelInvoker>,
    exchanges: Mutex<Vec<Exchange>>,
}

struct IgnoreDeltas;
impl ModelEventSink for IgnoreDeltas {
    fn emit(&mut self, _: ash_protocol::ModelStreamEvent) -> Result<(), ModelProviderError> {
        Ok(())
    }
}

impl ModelService for Luna {
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
        let started = Instant::now();
        let response = self
            .model
            .stream_with_cancellation(&request, cancellation, &mut IgnoreDeltas)
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
                advisor: None,
                command_id: CommandId::new(label).unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: Some(model_ref()),
                kind: Default::default(),
                instructions: ash_protocol::TurnInstructions::new(
                    "live-cache-test",
                    "live-cache-test",
                    "1",
                    "This is a synthetic cache test. Reply with exactly ACK. Do not use tools.",
                )
                .unwrap(),
                policy_revision: "test".into(),
                approval_mode: ash_protocol::ApprovalMode::AskPermissions,
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
        ash_model_provider_config::ProviderConfigRegistry::builtin(),
        secrets,
    )
    .with_chatgpt_oauth(auth);
    let luna = Arc::new(Luna {
        model: runtime
            .build_model(
                &ash_model_provider_config::ModelProviderConfig::new(model_ref().provider),
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
