use super::*;
use ash_core::RecordToolCallRequest;
use ash_core::StartGoalTurnRequest;
use ash_core::StartTurnRequest;
use ash_core::ThreadEventBatch;
use ash_core::ThreadStore;
use ash_protocol::ToolName;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use core_api::SequenceExpectation;
use core_api::StartThreadRequest;
use std::time::Instant;

#[test]
fn legacy_goal_failure_does_not_block_startup_or_other_goal_recovery() {
    struct RecoveryModel(std::sync::atomic::AtomicUsize);
    impl OperationClient for RecoveryModel {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            panic!("unexpected non-streaming request: {}", request.url());
        }

        fn execute_streaming(
            &self,
            request: &ClientRequest,
            sink: &mut dyn ash_client::OperationStreamSink,
        ) -> Result<ClientResponse, ClientError> {
            assert_eq!(request.url(), "http://localhost:11434/v1/chat/completions");
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            sink.emit(b"data: {\"id\":\"recovered\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"recovered answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"recovered\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\ndata: [DONE]\n\n")?;
            Ok(ClientResponse::new(200, vec![], vec![]))
        }
    }
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    let mut provider = ModelProviderConfig::new(ProviderId::new("ollama").unwrap());
    provider.model_context.insert(
        ModelId::new("recovery-fixture").unwrap(),
        ModelContextConfig {
            context_window: Some(32_000),
            long_context: None,
            auto_compact_token_limit: None,
        },
    );
    runtime
        .config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("recovery-model-config").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureConnection {
                connection: provider.connection.clone(),
                config: provider,
            },
        })
        .unwrap();

    let initial = open_app_server(
        AppServerOptions::new(profile.path())
            .with_profile_runtime(runtime.clone())
            .with_codex_home(profile.path().join("codex"))
            .with_dir_root(directory.path())
            .without_built_in_skills(),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let mut created_threads = Vec::new();
    for name in ["first-recovered-goal", "second-recovered-goal"] {
        created_threads.push(
            initial
                .start_thread(StartThreadRequest {
                    agent_id: None,
                    agent: None,
                    command_id: CommandId::new(name).unwrap(),
                    title: name.into(),
                    branch_name: None,
                    execution_target: None,
                })
                .unwrap(),
        );
    }
    // Use the production directory provisioning and place the broken task first in recovery.
    created_threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    let mut recovered_turns = Vec::new();
    for (index, created) in created_threads.into_iter().enumerate() {
        let thread_id = created.thread_id;
        let legacy_advisor = (index == 0)
            .then(|| serde_json::from_value(serde_json::json!({"enabled":true})).unwrap());
        let source_store = Arc::new(ash_core::InMemoryThreadStore::default());
        source_store
            .append_batch(&ThreadEventBatch {
                history_index: None,
                history_prefixes: Vec::new(),
                batch_id: format!("copy-{thread_id}"),
                thread_id: thread_id.clone(),
                expected_sequence: 0,
                events: runtime.history.load(&thread_id).unwrap(),
                catalog: runtime.threads.thread_catalog_record(&thread_id).unwrap(),
            })
            .unwrap();
        let source = ThreadController::with_store(source_store.clone());
        source
            .create_goal(&thread_id, "finish recovered work".into(), Some(1))
            .unwrap();
        let turn_id = source
            .start_goal_turn(
                &thread_id,
                StartGoalTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: CommandId::new("recovered-goal-turn").unwrap(),
                    model: Some(ModelRef::new(
                        ProviderId::new("ollama").unwrap(),
                        ModelId::new("recovery-fixture").unwrap(),
                    )),
                    reasoning_effort: None,
                    policy_revision: "test".into(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                },
            )
            .unwrap()
            .unwrap()
            .turn_id;
        source
            .record_tool_call(
                &thread_id,
                &turn_id,
                RecordToolCallRequest {
                    tool_call_id: None,
                    name: ToolName::new("sleep").unwrap(),
                    arguments_json: r#"{"duration_ms":1}"#.into(),
                    binding: None,
                },
            )
            .unwrap();
        let mut events: Vec<_> = source_store
            .events()
            .into_iter()
            .filter(|event| event.sequence > created.sequence)
            .collect();
        // Seed the journal shape written before Goal admission froze inherited Advisors.
        for event in &mut events {
            if let ash_protocol::ThreadEvent::TurnAccepted { advisor, .. } = &mut event.event {
                *advisor = legacy_advisor.clone();
                let ash_protocol::ThreadCommand::StartTurn {
                    advisor: command_advisor,
                    ..
                } = &mut event.command.as_mut().unwrap().command
                else {
                    unreachable!();
                };
                *command_advisor = advisor.clone();
            }
        }
        runtime
            .history
            .append_batch(&ThreadEventBatch {
                history_index: None,
                history_prefixes: Vec::new(),
                batch_id: format!("seed-{thread_id}"),
                thread_id: thread_id.clone(),
                expected_sequence: created.sequence,
                events,
                catalog: source.thread_catalog_record(&thread_id).unwrap(),
            })
            .unwrap();
        recovered_turns.push((thread_id, turn_id));
    }
    drop(initial);
    drop(runtime);
    let client = Arc::new(RecoveryModel(std::sync::atomic::AtomicUsize::new(0)));
    let open = || {
        open_app_server(
            AppServerOptions::new(profile.path())
                .with_codex_home(profile.path().join("codex"))
                .with_dir_root(directory.path())
                .with_model_operation_client(client.clone())
                .without_built_in_skills(),
            ash_app_server_diff::compute,
        )
        .expect("one failed recovery must not block App Server startup")
    };
    let server = open();
    let mut connection = server.connection();
    let initialized = local_call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"clientInfo":{"name":"goal-recovery-test","version":"1"},"capabilities":{}}
        }),
    );
    assert!(initialized.get("result").is_some(), "{initialized}");
    let (legacy_thread, legacy_turn) = &recovered_turns[0];
    let failed = server.threads().read_thread(legacy_thread).unwrap();
    assert_eq!(failed.turns[0].turn_id, *legacy_turn);
    assert_eq!(failed.turns[0].status, TurnStatus::Failed);
    assert_eq!(
        failed.turns[0].failure,
        Some(ash_protocol::StableTurnError::model_invocation_failed())
    );
    assert_eq!(
        failed.goal.unwrap().status,
        ash_protocol::ThreadGoalStatus::Blocked
    );
    let (healthy_thread, healthy_turn) = &recovered_turns[1];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let healthy = server.threads().read_thread(healthy_thread).unwrap();
        assert_eq!(healthy.turns[0].turn_id, *healthy_turn);
        assert_ne!(
            healthy.turns[0].status,
            TurnStatus::Failed,
            "healthy recovery failed: {:?}",
            healthy.turns[0].failure
        );
        if healthy.turns[0].status == TurnStatus::Completed {
            assert_eq!(
                healthy.goal.unwrap().status,
                ash_protocol::ThreadGoalStatus::BudgetLimited
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "healthy Goal did not recover: {:?}",
            healthy.turns[0].status
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    server.close_connection(connection);
    drop(server);
    let restarted = open();
    let persisted = restarted.threads().read_thread(legacy_thread).unwrap();
    assert_eq!(persisted.sequence, failed.sequence);
    assert_eq!(persisted.turns[0].status, TurnStatus::Failed);
    assert_eq!(client.0.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn model_provider_migration_keeps_idle_history_lazy_across_directory_hosts() {
    let profile = tempfile::tempdir().unwrap();
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let runtime = LocalProfileRuntime::open(profile.path()).unwrap();
    for index in 0..24 {
        let id = format!("idle-{index}");
        runtime
            .threads
            .create_thread(ash_core::CreateThreadRequest {
                execution_target: None,
                agent_id: ash_protocol::AgentId::new(format!("agent-{index}")).unwrap(),
                origin: Default::default(),
                agent: None,
                session_id: ash_protocol::SessionId::new(id.clone()).unwrap(),
                thread_id: ash_protocol::ThreadId::new(id).unwrap(),
                title: "Idle history".into(),
            })
            .unwrap();
    }
    drop(runtime);
    let runtime = Arc::new(LocalProfileRuntime::open(profile.path()).unwrap());
    assert!(runtime.threads.list_loaded_threads().unwrap().is_empty());
    for directory in [first_dir.path(), second_dir.path()] {
        let server = open_app_server(
            AppServerOptions::new(profile.path())
                .with_profile_runtime(runtime.clone())
                .with_dir_root(directory)
                .without_built_in_skills(),
            ash_app_server_diff::compute,
        )
        .unwrap();
        assert!(server.threads().list_loaded_threads().unwrap().is_empty());
    }
    // A shared profile can receive older history after its first Directory has opened.
    let id = ash_protocol::ThreadId::new("idle-0").unwrap();
    runtime
        .threads
        .configure_advisor(
            &id,
            CommandId::new("late-legacy-advisor").unwrap(),
            SequenceExpectation::Any,
            ash_protocol::AdvisorSelection::Model {
                config: ash_protocol::AdvisorConfig::new(ModelRef::new(
                    ProviderId::new("bigmodel").unwrap(),
                    ModelId::new("model").unwrap(),
                )),
            },
        )
        .unwrap();
    let server = open_app_server(
        AppServerOptions::new(profile.path())
            .with_profile_runtime(runtime.clone())
            .with_dir_root(first_dir.path())
            .without_built_in_skills(),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let loaded = server.threads().list_loaded_threads().unwrap();
    assert_eq!(loaded.len(), 1);
    assert!(
        matches!(&loaded[0].advisor, ash_protocol::AdvisorSelection::Model { config }
        if config.model.as_ref().is_some_and(|model| model.provider.as_str() == "glm"))
    );
}

#[test]
fn initial_directory_opens_before_recovered_tool_continuations_resume() {
    for user_config in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let options = || {
            let options = AppServerOptions::new(profile.path())
                .with_codex_home(profile.path().join("codex"))
                .without_built_in_skills();
            if user_config {
                options.with_user_config_dir_root(directory.path())
            } else {
                options.with_dir_root(directory.path())
            }
        };
        let server = open_app_server(options(), ash_app_server_diff::compute).unwrap();
        let thread = server
            .start_thread(StartThreadRequest {
                agent_id: None,
                agent: None,
                command_id: CommandId::new("recovery-thread").unwrap(),
                title: "Interrupted process".into(),
                branch_name: None,
                execution_target: None,
            })
            .unwrap();
        let turn = server
            .threads()
            .start_turn(
                &thread.thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: CommandId::new("recovery-turn").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: "test".into(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: "wait".into(),
                    }],
                },
            )
            .unwrap();
        server
            .threads()
            .record_tool_call(
                &thread.thread_id,
                &turn.turn_id,
                RecordToolCallRequest {
                    tool_call_id: None,
                    name: ToolName::new("sleep").unwrap(),
                    arguments_json: r#"{"duration_ms":30000}"#.into(),
                    binding: None,
                },
            )
            .unwrap();
        assert!(
            server
                .threads()
                .read_thread(&thread.thread_id)
                .unwrap()
                .has_resumable_tool_continuation(&turn.turn_id)
        );
        // A real directory change must still reject live work. Only startup installs
        // services before resuming the recovered, not-yet-running continuation.
        assert_eq!(
            server
                .switch_local_dir_root(directory.path().to_path_buf())
                .unwrap_err()
                .to_string(),
            "a Turn is still active in the current Directory"
        );
        drop(server);

        let recovered = open_app_server(options(), ash_app_server_diff::compute)
            .expect("recovered work must not block startup");
        let mut connection = recovered.connection();
        let initialized = local_call(
            &recovered,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{"clientInfo":{"name":"recovery-test","version":"1"},"capabilities":{}}
            }),
        );
        assert!(initialized.get("result").is_some(), "{initialized}");
        let snapshot = recovered.threads().read_thread(&thread.thread_id).unwrap();
        assert_ne!(snapshot.turns[0].status, TurnStatus::Created);
        recovered.close_connection(connection);
    }
}

#[test]
fn unavailable_keyring_allows_local_model_turns_and_queue_restart() {
    struct LocalModel(std::sync::atomic::AtomicUsize);
    impl OperationClient for LocalModel {
        fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
            panic!("unexpected non-streaming request: {}", request.url());
        }

        fn execute_streaming(
            &self,
            request: &ClientRequest,
            sink: &mut dyn ash_client::OperationStreamSink,
        ) -> Result<ClientResponse, ClientError> {
            assert_eq!(request.url(), "http://localhost:11434/v1/chat/completions");
            assert!(
                !request
                    .headers()
                    .iter()
                    .any(|header| { header.name().eq_ignore_ascii_case("authorization") })
            );
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            sink.emit(b"data: {\"id\":\"local\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"local-model-ok\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"local\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")?;
            Ok(ClientResponse::new(200, vec![], vec![]))
        }
    }
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let client = Arc::new(LocalModel(std::sync::atomic::AtomicUsize::new(0)));
    let profile_runtime = || {
        let mut runtime = LocalProfileRuntime::open(profile.path()).unwrap();
        // Use the production encrypted store with a deterministic unavailable keyring.
        runtime.secrets = Arc::new(
            ash_secrets::ProfileSecretStore::open(
                profile.path().join("secrets"),
                Arc::new(ash_secrets::UnavailableSecretStore),
            )
            .unwrap(),
        );
        runtime
    };
    let runtime = profile_runtime();
    let mut provider = ModelProviderConfig::new(ProviderId::new("ollama").unwrap());
    provider.model_context.insert(
        ModelId::new("local-fixture").unwrap(),
        ModelContextConfig {
            context_window: Some(32_000),
            long_context: None,
            auto_compact_token_limit: None,
        },
    );
    let configured = runtime
        .config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("local-model-config").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::ConfigureConnection {
                connection: provider.connection.clone(),
                config: provider,
            },
        })
        .unwrap();
    runtime
        .config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("local-model-default").unwrap(),
            expected_revision: configured.revision,
            command: UserConfigCommand::UpdatePreferences(PreferencesUpdate {
                model: Patch::Value(ModelRef::new(
                    ProviderId::new("ollama").unwrap(),
                    ModelId::new("local-fixture").unwrap(),
                )),
                ..Default::default()
            }),
        })
        .unwrap();
    let open = |runtime| {
        open_app_server(
            AppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::new(runtime))
                .with_codex_home(profile.path().join("codex"))
                .with_dir_root(directory.path())
                .with_model_operation_client(client.clone())
                .without_built_in_skills(),
            ash_app_server_diff::compute,
        )
        .unwrap()
    };
    let server = open(runtime);
    let mut connection = server.connection();
    let next_id = std::cell::Cell::new(1);
    let rpc = |method: &str, params: serde_json::Value, connection: &mut ConnectionState| {
        let id = next_id.get();
        next_id.set(id + 1);
        let response = local_call(
            &server,
            connection,
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        );
        assert!(response.get("error").is_none(), "{method}: {response}");
        response["result"].clone()
    };
    rpc(
        "initialize",
        serde_json::json!({"clientInfo":{"name":"keyring-recovery-test","version":"1"},"capabilities":{}}),
        &mut connection,
    );
    assert_eq!(
        rpc("secrets/status", serde_json::json!({}), &mut connection),
        serde_json::json!({"status":"unavailable","mode":"encrypted"})
    );
    let created = rpc(
        "session/create",
        serde_json::json!({"commandId":"local-model-session","title":"Local model","executionTarget":null}),
        &mut connection,
    );
    let session = created["session"]["sessionId"].as_str().unwrap();
    let thread = created["session"]["threads"][0]["threadId"]
        .as_str()
        .unwrap();
    let initial = rpc(
        "session/thread/read",
        serde_json::json!({"sessionId":session,"threadId":thread}),
        &mut connection,
    );
    rpc(
        "session/request",
        serde_json::json!({"commandId":"local-model-turn","sessionId":session,"request":{
            "type":"startTurn","threadId":thread,"expectedSequence":initial["thread"]["sequence"],
            "input":[{"type":"text","text":"first local turn"}]
        }}),
        &mut connection,
    );
    let thread_id = ash_protocol::ThreadId::new(thread).unwrap();
    let wait = |server: &crate::AppServer, count: usize| {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = server.threads().read_thread(&thread_id).unwrap();
            if snapshot.turns.len() == count
                && snapshot.turns[count - 1].status == TurnStatus::Completed
            {
                return;
            }
            assert!(
                !snapshot
                    .turns
                    .iter()
                    .any(|turn| turn.status == TurnStatus::Failed)
                    && std::time::Instant::now() < deadline,
                "local model did not complete: {snapshot:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    wait(&server, 1);
    let message: queue::QueuedMessage = serde_json::from_value(rpc(
        "queue/enqueue",
        serde_json::json!({"commandId":"local-model-queued","sessionId":session,"threadId":thread,
            "mode":"agent","input":[{"type":"text","text":"second local turn"}],
            "toolMode":"direct","approvalMode":ash_protocol::ApprovalMode::default()}),
        &mut connection,
    ))
    .unwrap();
    assert!(message.request.model.is_none());
    server.close_connection(connection);
    drop(server);

    let restarted = Arc::new(open(profile_runtime()));
    let queue = restarted.start_queue().unwrap().unwrap();
    wait(&restarted, 2);
    assert_eq!(client.0.load(std::sync::atomic::Ordering::Relaxed), 2);
    assert_eq!(
        restarted.threads().read_thread(&thread_id).unwrap().turns[1].model,
        Some(ModelRef::new(
            ProviderId::new("ollama").unwrap(),
            ModelId::new("local-fixture").unwrap()
        ))
    );
    let mut connection = restarted.connection();
    let initialized = local_call(
        &restarted,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "clientInfo":{"name":"keyring-recovery-test","version":"1"},"capabilities":{}}}),
    );
    assert!(initialized.get("error").is_none(), "{initialized}");
    let status = local_call(
        &restarted,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"secrets/status","params":{}}),
    );
    assert_eq!(
        status["result"],
        serde_json::json!({"status":"unavailable","mode":"encrypted"})
    );
    restarted.close_connection(connection);
    drop(queue);
}
