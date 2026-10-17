use super::*;
use crate::ConnectionState;
use crate::local::ProviderModelService;
use crate::local_tools::LocalToolComposition;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;
use ash_cloud_codebase::CloudCodebaseCapabilities;
use ash_cloud_codebase::CloudCodebaseDeletionSupport;
use ash_cloud_codebase::CloudCodebaseDestination;
use ash_cloud_codebase::CloudCodebaseGrant;
use ash_cloud_codebase::CloudCodebaseGrantId;
use ash_cloud_codebase::CloudCodebaseId;
use ash_cloud_codebase::CloudCodebaseProvider;
use ash_cloud_codebase::CloudCodebaseProviderError;
use ash_cloud_codebase::CloudCodebaseProviderId;
use ash_cloud_codebase::CloudCodebaseProviderRegistry;
use ash_cloud_codebase::CloudCodebasePublication;
use ash_cloud_codebase::CloudCodebasePublicationRequest;
use ash_cloud_codebase::CloudCodebaseSelection;
use ash_cloud_codebase::CloudCodebaseState;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::ConfigStore;
use ash_config::ToolSearchConfig;
use ash_config::ToolSearchModeConfig;
use ash_config::UserConfigCommand;
use ash_core::InMemoryThreadStore;
use ash_core::NoTools;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_file_access::GrantSource;
use ash_home::AshHome;
use ash_model_provider::EchoModel;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::EmbeddingResponse;
use ash_model_provider::EmbeddingVector;
use ash_model_provider::ModelProviderError;
use ash_protocol::CommandId;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::UserInput;
use ash_shell_command::RipgrepExecutable;
use ash_utils_absolute_path::AbsolutePathBuf;
use core_api::ActionPolicyService;
use core_api::CoreError;
use core_api::SequenceExpectation;
use core_api::StartThreadRequest;
use model_provider_info::ModelProviderConfig;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

#[derive(Default)]
struct RequestRecordingModel {
    requests: Mutex<Vec<ash_protocol::ModelRequest>>,
}

impl core_api::ModelService for RequestRecordingModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        _: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(ash_protocol::ModelResponse {
            output: vec![ash_protocol::ResponseItem::Text("done".into())],
            usage: None,
            billing: None,
            stop_reason: ash_protocol::StopReason::Completed,
        })
    }
}

#[test]
fn directory_cleanup_does_not_retain_the_disposed_environment_runtime() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let server = crate::open_app_server(
        crate::AppServerOptions::new(profile.path())
            .without_built_in_skills()
            .with_dir_root(directory.path()),
    )
    .unwrap();
    assert!(server.dir_services.is_some());
    let runtime = Arc::downgrade(&server.env_runtime);
    drop(server);
    assert!(runtime.upgrade().is_none());
}

#[test]
fn clearing_directories_keeps_home_instructions_in_model_requests() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("instructions")).unwrap();
    std::fs::write(
        root.path().join("instructions/user.md"),
        "---\nname: user\nload: global\n---\n\nKeep this user guidance.\n",
    )
    .unwrap();
    let home = Arc::new(AshHome::new(
        AbsolutePathBuf::from_absolute(root.path()).unwrap(),
    ));
    let model = Arc::new(RequestRecordingModel::default());
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let server = AppServer::new(threads, model.clone())
        .with_ephemeral_env_state()
        .with_home(home)
        .with_local_env_host(None, host_policy())
        .unwrap();
    server.activate_local_dirs(Vec::new()).unwrap();
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-home-thread").unwrap(),
            title: "home".into(),
        })
        .unwrap();
    let turn = server
        .threads
        .start_turn(
            &thread.thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-home-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "hello".into(),
                }],
            },
        )
        .unwrap();
    server
        .turn_executor_backend()
        .start(&thread.thread_id, &turn.turn_id)
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    let request = loop {
        if let Some(request) = model.requests.lock().unwrap().first().cloned() {
            break request;
        }
        assert!(Instant::now() < deadline, "model request was not captured");
        std::thread::yield_now();
    };
    let ash_protocol::InputItem::Message(message) = &request.input[0] else {
        panic!("home instructions must precede the durable user input");
    };
    assert!(matches!(
        &message.content[0],
        ash_protocol::ContentPart::Text(text) if text.contains("Keep this user guidance.")
    ));
}

struct PermissionBoundSemanticEmbedding;

#[test]
fn init_does_not_import_external_instructions_into_agent_input() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("CLAUDE.md"), "External-only guidance.").unwrap();
    let server = server();
    let grant = ash_file_access::Grant::for_environment(
        Dir::open_local(root.path()).unwrap(),
        GrantSource::HostConfiguration,
        ash_file_access::Permissions::new([ash_file_access::Permission::LoadInstructions]),
    );
    server.env_runtime.write().unwrap().selected_grant = Some(grant);
    let mut input = vec![UserInput::Text {
        text: "/init workspace".into(),
    }];

    server
        .agent_processor()
        .turn_instruction_selection(&mut input, ash_protocol::CollaborationMode::Agent)
        .unwrap();

    assert!(!input.iter().any(|item| match item {
        UserInput::Text { text } => text.contains("External-only guidance."),
        UserInput::Context { content, .. } => content.contains("External-only guidance."),
        _ => false,
    }));
}

impl EmbeddingInvoker for PermissionBoundSemanticEmbedding {
    fn embed(&self, request: &EmbeddingRequest) -> Result<EmbeddingResponse, ModelProviderError> {
        EmbeddingResponse::new(
            request
                .inputs()
                .iter()
                .map(|_| EmbeddingVector::new(vec![1.0, 0.0]))
                .collect::<Result<Vec<_>, _>>()?,
        )
    }
}

#[test]
fn unavailable_hybrid_tool_search_remains_gated_and_reports_status() {
    let tools = EnvToolPorts::new(
        Arc::new(UpdateBroker::default()),
        ToolPort::host(Arc::new(NoTools), Arc::new(RejectPolicy)),
        ToolPort::application(Arc::new(NoTools), Arc::new(RejectPolicy)),
        None,
        None,
        None,
        None,
        &ToolSearchConfig::default(),
        &Default::default(),
        None,
    )
    .unwrap();
    let before = tools.state.lock().unwrap().registry_generation;
    let provider = ProviderId::new("ollama").unwrap();
    let model = ModelRef::new(provider.clone(), ModelId::new("nomic-embed-text").unwrap());
    let config = ToolSearchConfig {
        mode: ToolSearchModeConfig::HybridEmbedding,
        embedding_model: Some(model.clone()),
    };
    let providers =
        std::collections::BTreeMap::from([(provider.clone(), ModelProviderConfig::new(provider))]);

    tools
        .reconcile_user_config(None, &config, &providers)
        .unwrap();

    assert!(tools.state.lock().unwrap().registry_generation > before);
    assert_eq!(
        tools.tool_search_status(),
        ToolSearchEmbeddingStatus::Unavailable {
            model: Some(model),
            reason: "this App Server host does not provide semantic model invocation".into(),
        }
    );
}

#[test]
fn tool_catalog_notifications_follow_successful_installation_only() {
    let directory = TestDir::new("catalog-change", "file.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    let queue = crate::server::notification_queue::NotificationQueue::default();
    server.updates.register(1, false, &queue);

    server
        .commit_full_env_runtime(
            directory.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    queue.drain();
    host.tools.replace_host_available(true).unwrap();
    let events = queue.drain();
    assert!(
        events
            .iter()
            .any(|event| event["method"] == "agent/tools/changed")
    );
    assert!(
        host.tools
            .capabilities_snapshot()
            .0
            .iter()
            .any(|tool| tool.name == "browser_open")
    );

    host.tools.replace_host_available(true).unwrap();
    assert!(
        queue.drain().is_empty(),
        "unchanged catalogs must not emit invalidations"
    );
    assert!(
        host.tools
            .replace(|_| Err(EnvRuntimeError::Unavailable))
            .is_err()
    );
    assert!(
        queue.drain().is_empty(),
        "rejected replacements must not invalidate the catalog"
    );

    host.tools.replace_host_available(false).unwrap();
    assert!(
        queue
            .drain()
            .iter()
            .any(|event| event["method"] == "agent/tools/changed")
    );
    assert!(
        !host
            .tools
            .capabilities_snapshot()
            .0
            .iter()
            .any(|tool| tool.name == "browser_open")
    );
}

#[test]
fn env_runtime_replaces_directory_services_and_retains_connection_terminals() {
    let first = TestDir::new("first", "first.txt");
    let second = TestDir::new("second", "second.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();

    server
        .commit_full_env_runtime(first.authorization(), test_local_tools(), test_grep(), host)
        .unwrap();
    let tool_names = host
        .tools
        .reloadable
        .tools()
        .definitions()
        .into_iter()
        .map(|definition| definition.name.to_string())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(tool_names.contains(agent::SPAWN_AGENT_TOOL_NAME));
    assert!(tool_names.contains(agent::SEND_AGENT_MESSAGE_TOOL_NAME));
    assert!(tool_names.contains(agent::WAIT_AGENT_TOOL_NAME));
    assert!(tool_names.contains(crate::server::switch_mode_tool::SWITCH_MODE_TOOL_NAME));
    assert!(!tool_names.contains("browser_open"));
    host.tools.replace_host_available(true).unwrap();
    assert!(
        host.tools
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );
    let Ok(first_file_system) = server.file_system_service_for(None) else {
        panic!("first file system should be installed");
    };
    assert_eq!(
        first_file_system
            .read_file(Path::new("first.txt"), 1024)
            .unwrap(),
        b"first"
    );
    let Ok(first_search) = server.content_search_service_for(None) else {
        panic!("first search service should be installed");
    };
    let Ok(first_terminals) = server.terminal_service() else {
        panic!("first terminal service should be installed");
    };
    let Ok(first_git) = server.git_runtime_service() else {
        panic!("first Git runtime should be installed");
    };

    server
        .commit_full_env_runtime(
            second.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    let Ok(second_file_system) = server.file_system_service_for(None) else {
        panic!("second file system should be installed");
    };
    assert_eq!(
        second_file_system
            .read_file(Path::new("second.txt"), 1024)
            .unwrap(),
        b"second"
    );
    assert!(
        second_file_system
            .read_file(Path::new("first.txt"), 1024)
            .is_err()
    );
    let Ok(second_search) = server.content_search_service_for(None) else {
        panic!("second search service should be installed");
    };
    let Ok(second_terminals) = server.terminal_service() else {
        panic!("second terminal service should be installed");
    };
    let Ok(second_git) = server.git_runtime_service() else {
        panic!("second Git runtime should be installed");
    };

    assert!(!Arc::ptr_eq(&first_search, &second_search));
    assert_eq!(
        first_search.read(grep::Owner::new(1), "retired-search", 0, 1),
        Err(grep::JobError::Unavailable)
    );
    assert!(Arc::ptr_eq(&first_terminals, &second_terminals));
    assert!(!Arc::ptr_eq(&first_git, &second_git));
}

#[test]
fn local_env_host_rejects_an_unconfigured_state_mode() {
    let mut server = server();
    server.env_state = EnvStateMode::Unconfigured;

    let error = match server.with_local_env_host(None, host_policy()) {
        Ok(_) => panic!("unconfigured Directory state should be rejected"),
        Err(error) => error,
    };

    assert_eq!(
        error.to_string(),
        "local Directory host requires an explicit Directory state mode"
    );
}

#[test]
fn env_dirs_set_routes_services_by_stable_folder_id() {
    let first = TestDir::new("multi-root-first", "first.txt");
    let second = TestDir::new("multi-root-second", "second.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let mut connection = server.product_host_connection();
    server.handle_json(
        &mut connection,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "desktop", "version": "1"},
                "capabilities": {"directoryGrantsHost": {"version": 1}}
            }
        })
        .to_string(),
    );

    let response: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "env/dirs/set",
                "params": {"dirs": [
                    {"id": "z-first", "path": first.path, "grant": {"type": "host", "permissions": ["readFiles", "writeFiles", "executeCommands", "watchFiles", "browseFiles", "searchFiles", "loadInstructions", "loadConfig", "discoverSkills", "discoverMcp", "useLanguageServices", "discoverHooks", "discoverPlugins", "inspectRepository", "mutateRepository"]}},
                    {"id": "a-second", "path": second.path, "grant": {"type": "host", "permissions": ["readFiles", "writeFiles", "executeCommands", "watchFiles", "browseFiles", "searchFiles", "loadInstructions", "loadConfig", "discoverSkills", "discoverMcp", "useLanguageServices", "discoverHooks", "discoverPlugins", "inspectRepository", "mutateRepository"]}}
                ]}
            })
            .to_string(),
        ),
    )
    .unwrap();

    assert_eq!(response["result"]["dirs"][0]["id"], "a-second");
    assert_eq!(response["result"]["dirs"][1]["id"], "z-first");
    let Ok(first_files) = server.file_system_service_for(Some("z-first")) else {
        panic!("first folder file service should be available");
    };
    let Ok(second_files) = server.file_system_service_for(Some("a-second")) else {
        panic!("second folder file service should be available");
    };
    assert_eq!(
        first_files.read_file(Path::new("first.txt"), 1024).unwrap(),
        b"multi-root-first"
    );
    assert_eq!(
        second_files
            .read_file(Path::new("second.txt"), 1024)
            .unwrap(),
        b"multi-root-second"
    );
    assert!(server.file_system_service_for(Some("missing")).is_err());
    let Ok(first_terminal) = server.terminal_service_for(Some("z-first")) else {
        panic!("first folder terminal service should be available");
    };
    let Ok(second_terminal) = server.terminal_service_for(Some("a-second")) else {
        panic!("second folder terminal service should be available");
    };
    assert!(!Arc::ptr_eq(&first_terminal, &second_terminal));
    // The caller's first root owns default services even when its ID sorts last.
    assert!(Arc::ptr_eq(
        &first_terminal,
        &server.terminal_service_for(None).unwrap()
    ));
    assert!(Arc::ptr_eq(
        &server.debug_adapter_service_for(Some("z-first")).unwrap(),
        &server.debug_adapter_service_for(None).unwrap()
    ));
}

#[test]
fn dirs_are_session_scoped_and_removable() {
    let primary = TestDir::new("add-dir-primary", "primary.txt");
    let session_dir = TestDir::new("add-dir-extra", "extra.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    server
        .commit_full_env_runtime(
            primary.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    let first = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-add-dir-session").unwrap(),
            title: "first".into(),
        })
        .unwrap();
    let second = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-other-add-dir-session").unwrap(),
            title: "second".into(),
        })
        .unwrap();

    let (path, mutation, directories) = server
        .add_session_dir(
            &first.session_id,
            session_dir.path.clone(),
            host_directory_capabilities(),
        )
        .unwrap();

    assert_eq!(path, session_dir.root().canonical_path());
    assert_eq!(mutation, Mutation::AddedDir);
    assert_eq!(directories.revision, 1);
    assert_eq!(directories.dirs.len(), 1);
    assert_eq!(
        directories.dirs[0].path,
        session_dir.root().canonical_path()
    );
    assert_eq!(
        server
            .list_session_dirs(&second.session_id)
            .unwrap()
            .dirs
            .len(),
        0
    );
    let (mutation, directories) = server
        .remove_session_dir(&first.session_id, &session_dir.path)
        .unwrap();
    assert_eq!(mutation, Mutation::RemovedDir);
    assert!(directories.dirs.is_empty());
}

#[test]
fn cwd_directory_can_be_added_explicitly() {
    let primary = TestDir::new("add-dir-duplicate-primary", "primary.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    server
        .commit_full_env_runtime(
            primary.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    let session = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-primary-add-dir-session").unwrap(),
            title: "session".into(),
        })
        .unwrap();

    let (path, mutation, snapshot) = server
        .add_session_dir(
            &session.session_id,
            primary.path.clone(),
            host_directory_capabilities(),
        )
        .unwrap();

    assert_eq!(path, primary.root().canonical_path());
    assert_eq!(mutation, Mutation::AddedDir);
    assert_eq!(snapshot.dirs[0].path, primary.root().canonical_path());
}

#[test]
fn dir_mutation_requires_a_directory_grants_host_connection() {
    let primary = TestDir::new("add-dir-capability-primary", "primary.txt");
    let session_dir = TestDir::new("add-dir-capability-extra", "extra.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    server
        .commit_full_env_runtime(
            primary.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    let session = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-capability-add-dir-session").unwrap(),
            title: "session".into(),
        })
        .unwrap();
    let mut connection = server.connection();
    server.handle_json(
        &mut connection,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "renderer", "version": "1"},
                "capabilities": {}
            }
        })
        .to_string(),
    );

    let response: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/dirs/add",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                }
            })
            .to_string(),
        ),
    )
    .unwrap();

    assert_eq!(response["error"]["message"], "PermissionRequired");
}

#[test]
fn projectless_session_terminal_uses_its_grant_without_enabling_an_unscoped_terminal() {
    let dir = TestDir::new("projectless-session-terminal", "fixture.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    server
        .commit_limited_dir_runtime(
            Grant::for_environment(
                dir.root(),
                GrantSource::HostConfiguration,
                Permissions::new([
                    Permission::ReadFiles,
                    Permission::BrowseFiles,
                    Permission::InspectRepository,
                    Permission::WatchFiles,
                    Permission::SearchFiles,
                ]),
            ),
            server.local_env_host.as_ref().unwrap(),
        )
        .unwrap();
    let session = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("projectless-terminal-session").unwrap(),
            title: "fixture".into(),
        })
        .unwrap();
    let mut connection = server.product_host_connection();
    server.handle_json(&mut connection, &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "clientInfo":{"name":"fixture","version":"1"},"capabilities":{"directoryGrantsHost":{"version":1}}
    }}).to_string());
    let granted: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection, &serde_json::json!({
        "jsonrpc":"2.0","id":2,"method":"session/dirs/add","params":{
            "sessionId":session.session_id,"path":dir.path,"permissions":["readFiles","executeCommands"]
        }
    }).to_string())).unwrap();
    assert!(granted.get("error").is_none(), "{granted}");
    let encoded_session: String =
        url::form_urlencoded::byte_serialize(session.session_id.as_str().as_bytes()).collect();
    let encoded_path: String =
        url::form_urlencoded::byte_serialize(dir.path.to_str().unwrap().as_bytes()).collect();
    let scope = format!("session:{encoded_session}:{encoded_path}");
    let profiles: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc":"2.0","id":30,"method":"terminal/profile/list","params":{"dirId":scope}
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert!(
        profiles["result"]["profiles"]
            .as_array()
            .is_some_and(|profiles| !profiles.is_empty()),
        "{profiles}"
    );
    let unscoped_profiles: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc":"2.0","id":31,"method":"terminal/profile/list","params":{}
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(unscoped_profiles["error"]["message"], "TerminalUnavailable");
    let created: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection, &serde_json::json!({
        "jsonrpc":"2.0","id":3,"method":"terminal/create","params":{
            "dirId":scope,"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}
        }
    }).to_string())).unwrap();
    assert!(created.get("error").is_none(), "{created}");
    assert_eq!(
        created["result"]["ready"]["cwd"],
        dir.path.to_str().unwrap()
    );
    let terminal_id = created["result"]["terminalId"].as_str().unwrap();
    let unscoped: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection, &serde_json::json!({
        "jsonrpc":"2.0","id":4,"method":"terminal/create","params":{
            "rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}
        }
    }).to_string())).unwrap();
    assert_eq!(unscoped["error"]["message"], "TerminalUnavailable");
    let closed: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection, &serde_json::json!({
        "jsonrpc":"2.0","id":5,"method":"terminal/close","params":{"dirId":scope,"terminalId":terminal_id}
    }).to_string())).unwrap();
    assert!(closed.get("error").is_none(), "{closed}");
    server.close_connection(connection);
}

#[test]
fn directory_grants_are_revision_bound_and_filter_capability_snapshots() {
    let primary = TestDir::new("add-dir-permission-primary", "primary.txt");
    let session_dir = TestDir::new("add-dir-permission-extra", "extra.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    server
        .commit_full_env_runtime(
            primary.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    let session = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-permission-add-dir-session").unwrap(),
            title: "session".into(),
        })
        .unwrap();
    let mut connection = server.product_host_connection();
    server.handle_json(
        &mut connection,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "ash-code", "version": "1"},
                "capabilities": {"directoryGrantsHost": {"version": 1}}
            }
        })
        .to_string(),
    );
    let added: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/dirs/add",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                    "permissions": ["readFiles", "writeFiles"]
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(added["result"]["revision"], 1);

    let updated: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/directoryGrants/set",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                    "expectedRevision": 1,
                    "permissions": ["readFiles"]
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(updated["result"]["mutation"], "updated");
    assert_eq!(updated["result"]["revision"], 2);
    assert_eq!(
        updated["result"]["dirs"][0]["permissions"],
        serde_json::json!(["readFiles"])
    );
    let access = server
        .env_runtime
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .dir_grants
        .clone();
    assert!(
        access
            .snapshot_for(&session.session_id, Permission::MutateRepository)
            .unwrap()
            .unwrap()
            .authorizations()
            .is_empty()
    );

    let activated: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "session/directoryGrants/set",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                    "expectedRevision": 2,
                    "permissions": ["readFiles", "executeCommands", "watchFiles", "loadInstructions"]
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(activated["result"]["revision"], 3);
    {
        let runtime = server
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(runtime.workspace.session_dir_watchers.len(), 1);
        assert_eq!(
            runtime
                .dir_grants
                .snapshot_for(&session.session_id, Permission::ExecuteCommands)
                .unwrap()
                .unwrap()
                .authorizations()
                .len(),
            1
        );
    }
    let terminal: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "terminal/createInSessionDirectory",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                    "rows": 24,
                    "cols": 80,
                    "profile": {"type": "default"},
                    "lifecycle": {"type": "connectionOwned"}
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    let terminal_id = terminal["result"]["terminalId"]
        .as_str()
        .expect("authorized session-dir terminal should start")
        .to_owned();

    let encoded_session: String =
        url::form_urlencoded::byte_serialize(session.session_id.as_str().as_bytes()).collect();
    let encoded_path: String =
        url::form_urlencoded::byte_serialize(session_dir.path.to_str().unwrap().as_bytes())
            .collect();
    let scope = format!("session:{encoded_session}:{encoded_path}");
    let scoped: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection, &serde_json::json!({
        "jsonrpc":"2.0","id":50,"method":"terminal/create",
        "params":{"dirId":scope,"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}}
    }).to_string())).unwrap();
    assert!(scoped.get("error").is_none(), "{scoped}");
    assert_eq!(
        scoped["result"]["ready"]["cwd"],
        session_dir.path.to_str().unwrap()
    );
    let scoped_id = scoped["result"]["terminalId"].as_str().unwrap();
    let closed: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc":"2.0","id":51,"method":"terminal/close",
                "params":{"dirId":scope,"terminalId":scoped_id}
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert!(closed.get("error").is_none(), "{closed}");

    let deactivated: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 6,
                "method": "session/directoryGrants/set",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                    "expectedRevision": 3,
                    "permissions": ["readFiles"]
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(deactivated["result"]["revision"], 4);
    assert!(
        server
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .workspace
            .session_dir_watchers
            .is_empty()
    );
    let revoked_terminal: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "terminal/read",
                "params": {
                    "terminalId": terminal_id,
                    "afterSequence": 0,
                    "afterCommandSequence": 0,
                    "maxChunks": 1
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(revoked_terminal["error"]["message"], "TerminalNotFound");
    let revoked_scope: serde_json::Value = serde_json::from_str(&server.handle_json(&mut connection, &serde_json::json!({
        "jsonrpc":"2.0","id":52,"method":"terminal/create",
        "params":{"dirId":scope,"rows":24,"cols":80,"profile":{"type":"default"},"lifecycle":{"type":"connectionOwned"}}
    }).to_string())).unwrap();
    assert_eq!(revoked_scope["error"]["message"], "TerminalOperationFailed");

    let stale: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 8,
                "method": "session/directoryGrants/set",
                "params": {
                    "sessionId": session.session_id,
                    "path": session_dir.path,
                    "expectedRevision": 3,
                    "permissions": ["readFiles", "writeFiles"]
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(stale["error"]["message"], "RevisionConflict");
}

#[test]
fn restricted_dir_installs_only_non_executable_services() {
    let dir = TestDir::new("restricted", "readable.txt");
    let provider = Arc::new(GrantRevocationProvider::new());
    let provider_trait: Arc<dyn CloudCodebaseProvider> = provider;
    let providers = CloudCodebaseProviderRegistry::new([provider_trait]).unwrap();
    let server = server()
        .with_cloud_codebase_providers(providers)
        .with_local_env_host(None, DirGrantPolicy::InspectOnly)
        .unwrap();
    let application_tools = server.local_env_host.as_ref().unwrap().tools.definitions();
    assert!(
        application_tools
            .iter()
            .any(|tool| tool.name.as_str() == "list_threads")
    );

    assert_eq!(
        server.switch_local_dir_root(dir.path.clone()),
        Ok(dir.root().canonical_path().to_path_buf())
    );
    assert!(server.file_system_service_for(None).is_ok());
    assert!(server.codebase_service().is_ok());
    assert!(server.cloud_codebase_service().is_err());
    assert!(server.git_runtime_service().is_ok());
    assert!(server.content_search_service_for(None).is_ok());
    assert!(server.terminal_service().is_err());
    server
        .local_env_host
        .as_ref()
        .unwrap()
        .tools
        .replace_host_available(true)
        .unwrap();
    assert_eq!(
        server
            .local_env_host
            .as_ref()
            .unwrap()
            .tools
            .reloadable
            .tools()
            .definitions(),
        application_tools
    );
}

#[test]
fn sandbox_capabilities_report_each_configured_backend_and_network_policy() {
    let dir = TestDir::new("sandbox-diagnostics", "readable.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    server
        .commit_full_env_runtime(
            dir.authorization(),
            test_local_tools(),
            test_grep(),
            server.local_env_host.as_ref().unwrap(),
        )
        .unwrap();
    let mut connection = server.connection();
    server.handle_json(
        &mut connection,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"clientInfo":{"name":"sandbox-test","version":"1"},"capabilities":{}}
        })
        .to_string(),
    );
    let response: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc":"2.0", "id":2, "method":"agent/capabilities/read", "params":{}
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(response["result"]["localProcessSandboxConfigured"], true);
    let result = &response["result"];
    let diagnostics = result["sandboxDiagnostics"].as_array().unwrap();
    assert_eq!(result["sandboxPolicy"]["profile"], "command-defaults");
    assert!(result["sandboxPolicy"]["fileSystem"].is_string());
    assert!(result["sandboxPolicy"]["network"].is_string());
    assert_eq!(result["sandboxPolicy"]["pathRuleCount"], 0);
    assert_eq!(
        diagnostics.len(),
        result["sandboxBackends"].as_array().unwrap().len() * 3
    );
    for backend in result["sandboxBackends"].as_array().unwrap() {
        for network in ["denied", "allowed", "managed"] {
            let diagnostic = diagnostics
                .iter()
                .find(|entry| &entry["backend"] == backend && entry["network"] == network)
                .unwrap();
            match diagnostic["readiness"]["type"].as_str().unwrap() {
                "ready" => assert!(diagnostic["readiness"].get("reason").is_none()),
                "unsupported" | "unavailable" => assert!(
                    !diagnostic["readiness"]["reason"]
                        .as_str()
                        .unwrap()
                        .is_empty()
                ),
                state => panic!("unknown readiness: {state}"),
            }
        }
    }
}

#[test]
fn sandbox_settings_save_reconciles_command_policy_and_preserves_selected_profile() {
    use ash_sandboxing::FileSystemAccess;
    use ash_sandboxing::NetworkAccess;

    for selected_profile in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let config_path = profile.path().join("config.toml");
        std::fs::write(
            &config_path,
            format!(
                "schemaVersion = {}\n{}",
                ash_config::CONFIG_FILE_SCHEMA_VERSION,
                if selected_profile {
                    "[permissions]\ndefaultProfile = 'restricted'\n[permissions.profiles.restricted]\nextends = ':fullAccess'\nfileSystem = 'readOnly'\nnetwork = 'denied'\n"
                } else {
                    ""
                }
            ),
        )
        .unwrap();
        let server = crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .without_built_in_skills()
                .with_dir_root(directory.path()),
        )
        .unwrap();
        let store = server.config.as_ref().unwrap();
        let registry = &server.local_env_host.as_ref().unwrap().tools.reloadable;
        let token = ash_async_utils::CancellationSource::new().token();
        let mut connection = server.connection();
        let initialized = server.handle_json(&mut connection, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"sandbox-settings-test","version":"1"},"capabilities":{}}}"#);
        assert!(initialized.contains("\"result\""));
        for (index, files, network, expected_files, expected_network) in [
            (
                0,
                "readOnly",
                "denied",
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            ),
            (
                1,
                "directoryWrite",
                "allowed",
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Allowed,
            ),
        ] {
            // Hold the actual runtime gate so the save/recomposition gap is deterministic.
            let gate = server.env_runtime_gate.lock().unwrap();
            let before = store.committed_snapshot();
            let saved: serde_json::Value = serde_json::from_str(
                &server.handle_json(
                    &mut connection,
                    &serde_json::json!({
                        "jsonrpc":"2.0", "id":index + 2, "method":"config/update",
                        "params":{
                            "commandId":format!("save-sandbox-{index}"),
                            "expectedRevision":before.revision.get(),
                            "execution":{
                                "approvalMode":before.values.execution.approval_mode,
                                "commandFileAccess":files, "commandNetworkAccess":network
                            }
                        }
                    })
                    .to_string(),
                ),
            )
            .unwrap();
            assert!(saved.get("error").is_none(), "{saved}");
            let committed = store.committed_snapshot();
            assert_eq!(
                serde_json::to_value(committed.values.execution.command_file_access).unwrap(),
                files
            );
            assert_eq!(
                serde_json::to_value(committed.values.execution.command_network_access).unwrap(),
                network
            );
            assert_eq!(committed.values.permissions, before.values.permissions);
            let call = ash_protocol::ToolCall {
                id: ash_protocol::ToolCallId::new(format!("sandbox-save-pending-{index}")).unwrap(),
                name: ash_protocol::ToolName::new("shell-command").unwrap(),
                arguments: serde_json::json!({"program":std::env::current_exe().unwrap(), "arguments":[], "working_directory":"."}),
            };
            let review = registry.tools().prepare(&call).unwrap();
            let policy = server.shared_action_policy(registry.policy());
            let pending = !server
                .env_config
                .read()
                .unwrap()
                .tools
                .matches_runtime_permissions(&committed.values);
            assert_eq!(pending, !selected_profile);
            if pending {
                assert!(matches!(
                    policy.validate_execution(&review, ash_protocol::ToolExecutionAuthority::Sandboxed, &token),
                    Err(CoreError::Policy(reason)) if reason.contains("pending runtime reconciliation")
                ));
            }
            drop(gate);
            let deadline = Instant::now() + Duration::from_secs(10);
            while !server
                .env_config
                .read()
                .unwrap()
                .tools
                .matches_runtime_permissions(&committed.values)
            {
                assert!(
                    Instant::now() < deadline,
                    "saved sandbox configuration was not installed: {:?}",
                    registry.diagnostic()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            let call = ash_protocol::ToolCall {
                id: ash_protocol::ToolCallId::new(format!("sandbox-save-installed-{index}"))
                    .unwrap(),
                ..call
            };
            // Probe the installed executor reviewer and policy, rather than a configuration DTO.
            let review = registry.tools().prepare(&call).unwrap();
            let expected = if selected_profile {
                (FileSystemAccess::ReadOnly, NetworkAccess::Denied)
            } else {
                (expected_files, expected_network)
            };
            match registry.policy().decide(&review, &token).unwrap() {
                ExecutionDecision::RunSandboxed(policy) => {
                    assert_eq!((policy.file_system(), policy.network()), expected);
                }
                decision => panic!("expected sandboxed execution, got {decision:?}"),
            }
            policy
                .validate_execution(
                    &review,
                    ash_protocol::ToolExecutionAuthority::Sandboxed,
                    &token,
                )
                .unwrap();
        }
        // A fresh reader sees the saved artifact, independent of the in-memory ConfigStore.
        let persisted =
            ConfigStore::open_with_paths(profile.path().join("reopen.sqlite3"), config_path)
                .unwrap();
        let persisted = persisted.read_snapshot().unwrap();
        assert_eq!(
            persisted.values.execution,
            store.committed_snapshot().values.execution
        );
        assert_eq!(
            persisted.values.permissions,
            store.committed_snapshot().values.permissions
        );
    }
}

#[test]
fn sandbox_policy_installation_invalidates_diagnostics_with_an_unchanged_catalog() {
    let directory = TestDir::new("policy-invalidation", "file.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    server
        .initialize_local_dir_root(
            directory.path.clone(),
            crate::local::InitialDirGrantPolicy::HostConfiguration,
        )
        .unwrap();
    let tools = &server.local_env_host.as_ref().unwrap().tools;
    let catalog = tools.capabilities_snapshot().0;
    let queue = crate::server::notification_queue::NotificationQueue::default();
    server.updates.register(1, false, &queue);
    let mut config = ash_config::ResolvedConfig::default();
    config.execution.command_file_access = ash_config::CommandFileAccess::ReadOnly;
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_env_config(&config)
        .unwrap();
    assert_eq!(tools.capabilities_snapshot().0, catalog);
    assert!(
        server
            .env_config
            .read()
            .unwrap()
            .tools
            .matches_runtime_permissions(&config)
    );
    assert!(
        queue
            .drain()
            .iter()
            .any(|event| event["method"] == "agent/tools/changed")
    );
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_env_config(&config)
        .unwrap();
    assert!(
        queue.drain().is_empty(),
        "unchanged policy must not repeatedly invalidate diagnostics"
    );
}

#[test]
fn sandbox_managed_ceilings_reach_installed_executor_for_defaults_and_profiles() {
    use ash_sandboxing::FileSystemAccess;
    use ash_sandboxing::NetworkAccess;

    for selected_profile in [None, Some(":fullAccess")] {
        let dir = TestDir::new("managed-command-policy", "readable.txt");
        let mut config = ash_config::ResolvedConfig::default();
        config.execution.command_file_access = ash_config::CommandFileAccess::DirectoryWrite;
        config.execution.command_network_access = ash_config::CommandNetworkAccess::Allowed;
        config.permissions.default_profile = selected_profile.map(str::to_owned);
        let server = server()
            .with_env_config(&config)
            .with_local_env_host(None, host_policy())
            .unwrap();
        // Supply an already-validated administrator document at its owning boundary; tests
        // must never replace the machine-wide administrator-owned requirements file.
        server.env_config.write().unwrap().tools.requirements =
            Ok(ash_config::ManagedPermissions {
                source: PathBuf::from("managed-permissions-fixture"),
                values: ash_config::PermissionRequirements {
                    maximum_file_system: Some(ash_protocol::SandboxMode::ReadOnly),
                    maximum_network: Some(ash_config::CommandNetworkAccess::Denied),
                    host_read: Some(ash_config::HostReadAccess::GrantedRoots),
                    ..Default::default()
                },
            });
        server
            .initialize_local_dir_root(
                dir.path.clone(),
                crate::local::InitialDirGrantPolicy::HostConfiguration,
            )
            .unwrap();
        let registry = &server.local_env_host.as_ref().unwrap().tools.reloadable;
        let call = ash_protocol::ToolCall {
            id: ash_protocol::ToolCallId::new("managed-sandbox-probe").unwrap(),
            name: ash_protocol::ToolName::new("shell-command").unwrap(),
            arguments: serde_json::json!({"program":std::env::current_exe().unwrap(), "arguments":[], "working_directory":"."}),
        };
        let review = registry.tools().prepare(&call).unwrap();
        match registry
            .policy()
            .decide(&review, &ash_async_utils::CancellationSource::new().token())
            .unwrap()
        {
            ExecutionDecision::RunSandboxed(policy) => {
                assert_eq!(policy.file_system(), FileSystemAccess::ReadOnly);
                assert_eq!(policy.network(), NetworkAccess::Denied);
            }
            decision => panic!("managed ceiling was not enforced: {decision:?}"),
        }
    }
}

#[test]
fn initialize_browser_capability_versions_accept_supported_hosts_and_reject_invalid_declarations() {
    let server = server();
    for version in [3, 4] {
        for (observe, input) in [(true, false), (false, true), (true, true)] {
            let mut connection = server.connection();
            let response: serde_json::Value = serde_json::from_str(&server.handle_json(
                &mut connection,
                &serde_json::json!({
                    "jsonrpc": "2.0", "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": { "name": "desktop-browser-test", "version": "1" },
                        "capabilities": { "browser": { "version": version, "observe": observe, "input": input } }
                    }
                }).to_string(),
            )).unwrap();
            assert_eq!(
                response["result"]["capabilities"]["sessions"], true,
                "{response}"
            );
            assert!(connection.is_initialized());
            let configured: serde_json::Value = serde_json::from_str(
                &server.handle_json(
                    &mut connection,
                    &serde_json::json!({
                    "jsonrpc": "2.0", "id": 2, "method": "browser/configure",
                        "params": { "enabled": true, "cdpEnabled": true }
                    })
                    .to_string(),
                ),
            )
            .unwrap();
            assert!(configured.get("result").is_some(), "{configured}");
            server.close_connection(connection);
        }
    }
    for (version, observe, input) in [
        (0, true, true),
        (1, true, true),
        (2, true, true),
        (5, true, true),
        (u32::MAX, true, true),
        (3, false, false),
        (4, false, false),
    ] {
        let mut connection = server.connection();
        let response: serde_json::Value = serde_json::from_str(&server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0", "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "invalid-browser-test", "version": "1" },
                    "capabilities": { "browser": { "version": version, "observe": observe, "input": input } }
                }
            }).to_string(),
        )).unwrap();
        assert_eq!(response["error"]["code"], -32602, "{response}");
        assert!(!connection.is_initialized());
        server.close_connection(connection);
    }
}

#[test]
fn browser_tools_follow_capable_connection_lifecycle_with_explicit_permissions() {
    let dir = TestDir::new("browser-capability", "readable.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    assert_eq!(
        server.switch_local_dir_root(dir.path.clone()),
        Ok(dir.root().canonical_path().to_path_buf())
    );
    let tools = &server.local_env_host.as_ref().unwrap().tools;
    assert!(
        !tools
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );

    let mut connection = server.connection();
    let response: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "desktop-test", "version": "1" },
                    "capabilities": {
                        "browser": { "version": 3, "observe": true, "input": false }
                    }
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(response["result"]["capabilities"]["sessions"], true);
    assert!(
        !tools
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );

    let mut second_connection = server.connection();
    let second_response: serde_json::Value = serde_json::from_str(
        &server.handle_json(
            &mut second_connection,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "desktop-test-2", "version": "1" },
                    "capabilities": {
                        "browser": { "version": 4, "observe": true, "input": true }
                    }
                }
            })
            .to_string(),
        ),
    )
    .unwrap();
    assert_eq!(second_response["result"]["capabilities"]["sessions"], true);
    assert!(
        tools
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );
    server.close_connection(second_connection);
    assert!(
        !tools
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );
    server.close_connection(connection);
    assert!(
        !tools
            .definitions()
            .iter()
            .any(|definition| definition.name.as_str() == "browser_open")
    );
}

#[test]
fn dir_activation_loads_dir_skill_source() {
    let dir = TestDir::new("dir-skills", "readable.txt");
    let skill_root = dir.path.join(".ash/skills/review-dir");
    std::fs::create_dir_all(&skill_root).unwrap();
    std::fs::write(
        skill_root.join("SKILL.md"),
        "---\nname: review-dir\ndescription: Review this Directory\n---\n\nReview instructions.\n",
    )
    .unwrap();
    let server = server()
        .with_skill_runtime(
            ash_skills_extension::BuiltInSkillSource::Omitted,
            Arc::new(EmptySkillConfig),
            None,
        )
        .unwrap()
        .with_local_env_host(None, DirGrantPolicy::InspectOnly)
        .unwrap();

    server.switch_local_dir_root(dir.path.clone()).unwrap();

    assert!(
        server
            .skills
            .as_ref()
            .unwrap()
            .list(ash_skills_extension::SkillCatalogReload::Cached)
            .unwrap()
            .entries
            .is_empty()
    );
    server
        .commit_limited_dir_runtime(
            Grant::for_environment(
                dir.root(),
                GrantSource::HostConfiguration,
                Permissions::new([
                    Permission::ReadFiles,
                    Permission::BrowseFiles,
                    Permission::DiscoverSkills,
                ]),
            ),
            server.local_env_host.as_ref().unwrap(),
        )
        .unwrap();

    let snapshot = server
        .skills
        .as_ref()
        .unwrap()
        .list(ash_skills_extension::SkillCatalogReload::Cached)
        .unwrap();
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(
        snapshot.entries[0].catalog_entry.source().kind(),
        ash_skills::SkillSourceKind::Directory
    );
}

#[test]
fn user_config_permissions_are_resolved_for_each_client_requested_dir() {
    let dir = TestDir::new("config-permissions", "readable.txt");
    let root = Dir::open_local(&dir.path).unwrap();
    let config = Arc::new(ConfigStore::open(dir.path.join("permissions.sqlite3")).unwrap());
    let server = server()
        .with_local_env_host(None, DirGrantPolicy::UserConfig(Arc::clone(&config)))
        .unwrap();

    assert_eq!(
        server.switch_local_dir_root(dir.path.clone()),
        Ok(root.canonical_path().to_path_buf())
    );
    assert!(server.file_system_service_for(None).is_ok());
    assert!(server.terminal_service().is_err());

    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("set-dir-permissions").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: host_directory_capabilities(),
                display_path: None,
            },
        })
        .unwrap();

    assert_eq!(
        server.switch_local_dir_root(dir.path.clone()),
        Ok(root.canonical_path().to_path_buf())
    );
    assert!(server.git_runtime_service().is_ok());
    assert!(server.content_search_service_for(None).is_ok());
    assert!(server.terminal_service().is_ok());
}

#[test]
fn user_config_permissions_reactivate_an_active_restricted_dir() {
    let dir = TestDir::new("config-promotion", "readable.txt");
    let root = dir.root();
    let config = Arc::new(ConfigStore::open(dir.path.join("permissions.sqlite3")).unwrap());
    let server = server()
        .with_config_store(Arc::clone(&config))
        .with_local_env_host(None, DirGrantPolicy::UserConfig(Arc::clone(&config)))
        .unwrap();
    server.switch_local_dir_root(dir.path.clone()).unwrap();
    assert!(server.terminal_service().is_err());
    assert!(server.content_search_service_for(None).is_ok());

    let trusted = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("promote-config-dir").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: host_directory_capabilities(),
                display_path: None,
            },
        })
        .unwrap();
    assert!(
        server
            .environment_processor()
            .reconcile_active_directory_grant()
            .is_ok()
    );

    assert!(server.terminal_service().is_ok());
    assert!(server.content_search_service_for(None).is_ok());
    assert_eq!(trusted.revision.get(), 1);
}

#[test]
fn user_config_revocation_removes_executable_services_but_keeps_file_access() {
    let dir = TestDir::new("config-revocation", "readable.txt");
    let root = dir.root();
    let config = Arc::new(ConfigStore::open(dir.path.join("permissions.sqlite3")).unwrap());
    let trusted = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("grant-revoked-dir").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: host_directory_capabilities(),
                display_path: None,
            },
        })
        .unwrap();
    let server = server()
        .with_local_env_host(None, DirGrantPolicy::UserConfig(Arc::clone(&config)))
        .unwrap();
    let application_tools = server.local_env_host.as_ref().unwrap().tools.definitions();
    assert!(
        application_tools
            .iter()
            .any(|tool| tool.name.as_str() == "list_threads")
    );
    server.switch_local_dir_root(dir.path.clone()).unwrap();
    assert!(server.terminal_service().is_ok());
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-revocation-thread").unwrap(),
            title: "revocation".into(),
        })
        .unwrap();
    let turn = server
        .threads
        .start_turn(
            &thread.thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-revocation-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "must be interrupted".into(),
                }],
            },
        )
        .unwrap();

    let previous_files = server.file_system_service_for(None).unwrap();

    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("restrict-revoked-dir").unwrap(),
            expected_revision: trusted.revision,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: inspection_permissions(),
                display_path: None,
            },
        })
        .unwrap();
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_user_directory_grants(&config.read_snapshot().unwrap().values)
        .unwrap();

    assert!(
        previous_files
            .read_file(Path::new("readable.txt"), 1024)
            .is_err()
    );
    let Ok(file_system) = server.file_system_service_for(None) else {
        panic!("restricted filesystem should remain installed after permission revocation");
    };
    assert_eq!(
        file_system
            .read_file(Path::new("readable.txt"), 1024)
            .unwrap(),
        b"config-revocation"
    );
    assert!(server.codebase_service().is_ok());
    assert!(server.git_runtime_service().is_ok());
    assert!(server.content_search_service_for(None).is_err());
    assert!(server.terminal_service().is_err());
    assert_eq!(
        server
            .threads
            .read_thread(&thread.thread_id)
            .unwrap()
            .turns
            .iter()
            .find(|candidate| candidate.turn_id == turn.turn_id)
            .unwrap()
            .status,
        TurnStatus::Interrupted
    );
    assert_eq!(
        server
            .local_env_host
            .as_ref()
            .unwrap()
            .tools
            .reloadable
            .tools()
            .definitions(),
        application_tools
    );
}

#[test]
fn user_config_revocation_removes_local_semantic_model_access() {
    let dir = TestDir::new("semantic-revocation", "source.rs");
    let root = dir.root();
    let config = Arc::new(ConfigStore::open(dir.path.join("permissions.sqlite3")).unwrap());
    let trusted = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("grant-semantic-dir").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: host_directory_capabilities(),
                display_path: None,
            },
        })
        .unwrap();
    let models = crate::CodebaseModels::new(
        ash_codebase::EmbeddingIndexKey::new("permissions-test-v1").unwrap(),
        Arc::new(PermissionBoundSemanticEmbedding),
    );
    let server = server()
        .with_codebase_models(models)
        .with_local_env_host(None, DirGrantPolicy::UserConfig(Arc::clone(&config)))
        .unwrap();
    server.switch_local_dir_root(dir.path.clone()).unwrap();
    assert!(server.codebase_semantic_service().is_some());

    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("restrict-semantic-dir").unwrap(),
            expected_revision: trusted.revision,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: inspection_permissions(),
                display_path: None,
            },
        })
        .unwrap();
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_user_directory_grants(&config.read_snapshot().unwrap().values)
        .unwrap();

    assert!(server.codebase_semantic_service().is_none());
    assert!(server.codebase_service().is_ok());
}

#[test]
fn user_config_revocation_deletes_cloud_grant_and_removes_cloud_runtime() {
    let dir = TestDir::new("cloud-revocation", "source.rs");
    let root = dir.root();
    let config = Arc::new(ConfigStore::open(dir.path.join("permissions.sqlite3")).unwrap());
    let trusted = config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("grant-cloud-dir").unwrap(),
            expected_revision: ConfigRevision::INITIAL,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: host_directory_capabilities(),
                display_path: None,
            },
        })
        .unwrap();
    let provider = Arc::new(GrantRevocationProvider::new());
    let provider_trait: Arc<dyn CloudCodebaseProvider> = provider.clone();
    let providers = CloudCodebaseProviderRegistry::new([provider_trait]).unwrap();
    let server = server()
        .with_cloud_codebase_providers(providers)
        .with_local_env_host(None, DirGrantPolicy::UserConfig(Arc::clone(&config)))
        .unwrap();
    server.switch_local_dir_root(dir.path.clone()).unwrap();
    let Ok(codebase) = server.codebase_service() else {
        panic!("local Codebase should be installed under explicit permissions");
    };
    codebase.rebuild().unwrap();
    let Ok(controller) = server.cloud_codebase_service() else {
        panic!("cloud codebase controller should be installed under explicit permissions");
    };
    let grant = CloudCodebaseGrant {
        id: CloudCodebaseGrantId::new("grant-revocation-grant").unwrap(),
        codebase_id: CloudCodebaseId::new("grant-revocation-codebase").unwrap(),
        root_id: controller.root_id().as_str().to_owned(),
        destination: CloudCodebaseDestination::new(
            CloudCodebaseProviderId::new("grant-revocation").unwrap(),
            "tenant-a",
            "dir-index",
        )
        .unwrap(),
        selection: CloudCodebaseSelection::EntireIndex,
        max_egress_bytes: NonZeroU64::new(1024 * 1024).unwrap(),
    };
    assert_eq!(
        controller.authorize(grant).unwrap().state,
        CloudCodebaseState::Granted
    );

    config
        .apply(ConfigCommandRequest {
            command_id: CommandId::new("restrict-cloud-dir").unwrap(),
            expected_revision: trusted.revision,
            command: UserConfigCommand::SetDirectoryGrant {
                dir: root.id(),
                permissions: inspection_permissions(),
                display_path: None,
            },
        })
        .unwrap();
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_user_directory_grants(&config.read_snapshot().unwrap().values)
        .unwrap();

    assert!(server.cloud_codebase_service().is_err());
    assert_eq!(provider.deletions.load(Ordering::SeqCst), 1);
}

#[test]
fn restricted_activation_retries_a_persisted_pending_cloud_deletion() {
    let dir = TestDir::new("pending-cloud-deletion", "source.rs");
    let storage = tempfile::tempdir().unwrap();
    let provider = Arc::new(GrantRevocationProvider::new());
    let provider_trait: Arc<dyn CloudCodebaseProvider> = provider.clone();
    let providers = CloudCodebaseProviderRegistry::new([provider_trait]).unwrap();
    let first_server = server()
        .with_cloud_codebase_storage_root(storage.path())
        .with_cloud_codebase_providers(providers)
        .with_local_env_host(None, host_policy())
        .unwrap();
    first_server
        .switch_local_dir_root(dir.path.clone())
        .unwrap();
    let Ok(codebase) = first_server.codebase_service() else {
        panic!("local Codebase should be installed");
    };
    codebase.rebuild().unwrap();
    let Ok(controller) = first_server.cloud_codebase_service() else {
        panic!("cloud controller should be installed");
    };
    controller.authorize(cloud_grant(&controller)).unwrap();
    provider.fail_deletions.store(true, Ordering::SeqCst);
    assert!(controller.revoke().is_err());
    drop(controller);
    drop(first_server);

    provider.fail_deletions.store(false, Ordering::SeqCst);
    let provider_trait: Arc<dyn CloudCodebaseProvider> = provider.clone();
    let providers = CloudCodebaseProviderRegistry::new([provider_trait]).unwrap();
    let restricted_server = server()
        .with_cloud_codebase_storage_root(storage.path())
        .with_cloud_codebase_providers(providers)
        .with_local_env_host(None, DirGrantPolicy::InspectOnly)
        .unwrap();
    restricted_server
        .switch_local_dir_root(dir.path.clone())
        .unwrap();

    assert!(restricted_server.cloud_codebase_service().is_err());
    assert_eq!(provider.deletions.load(Ordering::SeqCst), 2);
}

#[test]
fn active_turn_blocks_directory_root_switch_without_changing_authority() {
    let first = TestDir::new("busy-first", "first.txt");
    let second = TestDir::new("busy-second", "second.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    server
        .commit_full_env_runtime(first.authorization(), test_local_tools(), test_grep(), host)
        .unwrap();
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-thread").unwrap(),
            title: "thread".into(),
        })
        .unwrap();
    server
        .threads
        .start_turn(
            &thread.thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "stay in the first Directory".into(),
                }],
            },
        )
        .unwrap();

    assert_eq!(
        server.switch_local_dir_root(second.path.clone()),
        Err(EnvRuntimeError::Busy)
    );
    let Ok(file_system) = server.file_system_service_for(None) else {
        panic!("first Directory file system should remain installed");
    };
    assert_eq!(
        file_system.read_file(Path::new("first.txt"), 1024).unwrap(),
        b"busy-first"
    );
    assert!(
        file_system
            .read_file(Path::new("second.txt"), 1024)
            .is_err()
    );
}

#[test]
fn active_turn_accepts_session_access_changes_and_revokes_old_snapshots() {
    let primary = TestDir::new("active-turn-add-dir-primary", "primary.txt");
    let session_dir = TestDir::new("active-turn-add-dir-extra", "extra.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let host = server.local_env_host.as_ref().unwrap();
    server
        .commit_full_env_runtime(
            primary.authorization(),
            test_local_tools(),
            test_grep(),
            host,
        )
        .unwrap();
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-active-add-dir-thread").unwrap(),
            title: "thread".into(),
        })
        .unwrap();
    server
        .threads
        .start_turn(
            &thread.thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("start-active-add-dir-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                reasoning_effort: None,
                policy_revision: "test-policy-v1".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "continue after the access scope changes".into(),
                }],
            },
        )
        .unwrap();

    let (path, mutation, _) = server
        .add_session_dir(
            &thread.session_id,
            session_dir.path.clone(),
            host_directory_capabilities(),
        )
        .unwrap();
    assert_eq!(path, session_dir.root().canonical_path());
    assert_eq!(mutation, Mutation::AddedDir);
    let access = {
        let runtime = server
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(&runtime.dir_grants)
    };
    let snapshot = access
        .snapshot_for(&thread.session_id, Permission::MutateRepository)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.revision().get(), 1);
    assert_eq!(snapshot.authorizations().len(), 1);
    let frozen_token = snapshot.authorizations()[0].clone();

    let (mutation, directories) = server
        .remove_session_dir(&thread.session_id, &session_dir.path)
        .unwrap();
    assert_eq!(mutation, Mutation::RemovedDir);
    assert!(directories.dirs.is_empty());
    assert!(frozen_token.ensure_active().is_err());
    let empty_snapshot = access
        .snapshot_for(&thread.session_id, Permission::MutateRepository)
        .unwrap()
        .unwrap();
    assert_eq!(empty_snapshot.revision().get(), 2);
    assert!(empty_snapshot.authorizations().is_empty());
}

#[test]
fn session_directory_move_changes_future_context_only_for_that_session() {
    let primary = TestDir::new("session-cwd-primary", "primary.txt");
    let target = TestDir::new("session-cwd-target", "target.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    server.switch_local_dir_root(primary.path.clone()).unwrap();
    let first = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-first-cwd-thread").unwrap(),
            title: "first".into(),
        })
        .unwrap();
    let second = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("create-second-cwd-thread").unwrap(),
            title: "second".into(),
        })
        .unwrap();
    let (cwd, _) = server
        .move_session_dir(&first.session_id, target.path.clone(), Permissions::new([]))
        .unwrap();
    assert_eq!(cwd, target.root().canonical_path());

    let contributions = server
        .env_runtime
        .read()
        .unwrap()
        ._dir_contributions
        .clone()
        .unwrap();
    let turn_id = ash_protocol::TurnId::new("session-cwd-test-turn").unwrap();
    let context = |thread: &ash_core::ThreadSnapshot| {
        ash_core::HarnessContextProvider::snapshot(
            contributions.as_ref(),
            &ash_core::HarnessContextRequest {
                scope: ash_core::HarnessContextScope::Turn {
                    session_id: &thread.session_id,
                    thread_id: &thread.thread_id,
                    turn_id: &turn_id,
                },
                read_paths: &[],
            },
        )
        .unwrap()
        .environment()
        .unwrap()
        .render()
    };
    assert!(context(&first).contains(&format!("<cwd>{}</cwd>", cwd.display())));
    assert!(!context(&second).contains(&format!("<cwd>{}</cwd>", cwd.display())));

    server.remove_session_dir(&first.session_id, &cwd).unwrap();
    assert!(!context(&first).contains(&format!("<cwd>{}</cwd>", cwd.display())));
}

#[test]
fn session_files_copy_within_the_selected_directory_and_reject_ambiguous_targets() {
    let primary = TestDir::new("session-file-copy", "original.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    server.switch_local_dir_root(primary.path.clone()).unwrap();
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("session-file-copy-thread").unwrap(),
            title: "Files".into(),
        })
        .unwrap();
    let selector =
        serde_json::json!({"sessionId":thread.session_id,"path":primary.root().canonical_path()});
    server
        .add_session_dir(
            &thread.session_id,
            primary.path.clone(),
            host_directory_capabilities(),
        )
        .unwrap();
    let copied = server.fs_processor().fs_copy(&serde_json::json!({
        "sessionDirectory":selector,"source":"original.txt","target":"copied.txt"
    }));
    assert!(copied.is_ok(), "{copied:?}");
    assert_eq!(
        std::fs::read(primary.path.join("copied.txt")).unwrap(),
        std::fs::read(primary.path.join("original.txt")).unwrap()
    );
    for params in [
        serde_json::json!({"source":"original.txt","target":"invalid.txt"}),
        serde_json::json!({"sessionDirectory":selector,"sourceDirId":"workspace","source":"original.txt","target":"invalid.txt"}),
        serde_json::json!({"sessionDirectory":selector,"targetDirId":"workspace","source":"original.txt","target":"invalid.txt"}),
    ] {
        assert_eq!(
            server.fs_processor().fs_copy(&params).unwrap_err().code,
            -32602
        );
    }
    assert!(!primary.path.join("invalid.txt").exists());
    for params in [
        serde_json::json!({"path":"","moveRequested":false}),
        serde_json::json!({"dirId":"workspace","sessionDirectory":selector,"path":"","moveRequested":false}),
    ] {
        assert_eq!(
            server
                .fs_processor()
                .fs_paste_system_files(&params)
                .unwrap_err()
                .code,
            -32602
        );
    }
}

fn server() -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_ephemeral_env_state()
}

fn test_local_tools() -> LocalToolComposition {
    LocalToolComposition::without_executors(Arc::new(NoTools), Arc::new(RejectPolicy))
}

fn test_grep() -> Arc<grep::Service> {
    Arc::new(
        grep::Service::new(
            grep::Backend::Ripgrep,
            RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap(),
            None,
        )
        .unwrap(),
    )
}

fn host_policy() -> DirGrantPolicy {
    DirGrantPolicy::HostSelectedDirs(GrantSource::HostConfiguration)
}

struct RejectPolicy;

struct EmptySkillConfig;

struct GrantRevocationProvider {
    id: CloudCodebaseProviderId,
    deletions: AtomicUsize,
    fail_deletions: AtomicBool,
}

impl GrantRevocationProvider {
    fn new() -> Self {
        Self {
            id: CloudCodebaseProviderId::new("grant-revocation").unwrap(),
            deletions: AtomicUsize::new(0),
            fail_deletions: AtomicBool::new(false),
        }
    }
}

impl CloudCodebaseProvider for GrantRevocationProvider {
    fn id(&self) -> &CloudCodebaseProviderId {
        &self.id
    }

    fn capabilities(&self) -> CloudCodebaseCapabilities {
        CloudCodebaseCapabilities {
            deletion: CloudCodebaseDeletionSupport::IdempotentGrantDeletion,
        }
    }

    fn publish(
        &self,
        _request: CloudCodebasePublicationRequest,
    ) -> Result<CloudCodebasePublication, CloudCodebaseProviderError> {
        Ok(CloudCodebasePublication {
            remote_generation: "dir-index-ready".into(),
        })
    }

    fn query(
        &self,
        _request: ash_cloud_codebase::CloudCodebaseQueryRequest,
    ) -> Result<ash_cloud_codebase::CloudCodebaseQueryResult, CloudCodebaseProviderError> {
        Err(CloudCodebaseProviderError::new("query not configured"))
    }

    fn delete_grant(&self, _grant: &CloudCodebaseGrant) -> Result<(), CloudCodebaseProviderError> {
        self.deletions.fetch_add(1, Ordering::SeqCst);
        if self.fail_deletions.load(Ordering::SeqCst) {
            return Err(CloudCodebaseProviderError::new("delete failed"));
        }
        Ok(())
    }
}

fn cloud_grant(controller: &ash_cloud_codebase::CloudCodebaseController) -> CloudCodebaseGrant {
    CloudCodebaseGrant {
        id: CloudCodebaseGrantId::new("pending-deletion-grant").unwrap(),
        codebase_id: CloudCodebaseId::new("pending-deletion-codebase").unwrap(),
        root_id: controller.root_id().as_str().to_owned(),
        destination: CloudCodebaseDestination::new(
            CloudCodebaseProviderId::new("grant-revocation").unwrap(),
            "tenant-a",
            "dir-index",
        )
        .unwrap(),
        selection: CloudCodebaseSelection::EntireIndex,
        max_egress_bytes: NonZeroU64::new(1024 * 1024).unwrap(),
    }
}

impl ash_skills_extension::SkillConfigSnapshotProvider for EmptySkillConfig {
    fn snapshot(&self) -> Result<ash_config::SkillsConfig, String> {
        Ok(ash_config::SkillsConfig::default())
    }
}

impl ActionPolicyService for RejectPolicy {
    fn revision(&self) -> String {
        "test-policy-v1".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Err(CoreError::Policy("test policy rejects every action".into()))
    }
}

struct TestDir {
    path: PathBuf,
    _temporary: tempfile::TempDir,
}

impl TestDir {
    fn new(label: &str, file: &str) -> Self {
        // Keep environment fixtures outside the source checkout so Git discovery and
        // watchers cannot attach to the developer's repository.
        let temporary = tempfile::Builder::new().prefix(label).tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap();
        std::fs::write(path.join(file), label).unwrap();
        Self {
            path,
            _temporary: temporary,
        }
    }

    fn root(&self) -> Dir {
        Dir::open_local(&self.path).unwrap()
    }

    fn authorization(&self) -> Grant {
        Grant::for_environment(
            self.root(),
            GrantSource::HostConfiguration,
            host_directory_capabilities(),
        )
    }
}

#[test]
fn directory_search_and_backend_configuration_do_not_require_agent_execution() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("source.rs"), "search_without_agent\n").unwrap();
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let grant = Grant::for_environment(
        Dir::open_local(dir.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([
            Permission::ReadFiles,
            Permission::BrowseFiles,
            Permission::InspectRepository,
            Permission::WatchFiles,
            Permission::SearchFiles,
        ]),
    );
    server
        .commit_limited_dir_runtime(grant, server.local_env_host.as_ref().unwrap())
        .unwrap();
    let (grep, root) = server.grep_index_context().unwrap();
    let token = ash_async_utils::CancellationSource::new().token();
    let query = grep::Query {
        query: "search_without_agent".into(),
        pattern: grep::Pattern::Literal,
        case_sensitivity: grep::CaseSensitivity::Sensitive,
        scope: Default::default(),
        include_patterns: Vec::new(),
        exclude_patterns: Vec::new(),
        max_results: 10,
        freshness: grep::Freshness::Current,
    };
    assert_eq!(
        grep::Search::search(grep.as_ref(), &root, &query, &token)
            .unwrap()
            .matches
            .len(),
        1
    );
    assert!(server.content_search_service_for(None).is_ok());
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_env_config(&ash_config::ResolvedConfig {
            grep_backend: ash_config::GrepBackend::Ripgrep,
            ..Default::default()
        })
        .unwrap();
    assert!(!grep.index_status(&root, &token).unwrap().enabled);
    assert!(Arc::ptr_eq(&grep, &server.grep_index_context().unwrap().0));
}

#[test]
fn disabling_grep_index_preserves_directory_execution_policy_on_noop_and_replay() {
    let profile = tempfile::tempdir().unwrap();
    let dir = TestDir::new("grep-policy", "source.rs");
    let config_path = profile.path().join("config.toml");
    std::fs::write(
        &config_path,
        format!(
            "schemaVersion = {}\n[grep]\nbackend = 'ripgrep'\n",
            ash_config::CONFIG_FILE_SCHEMA_VERSION
        ),
    )
    .unwrap();
    let config = Arc::new(
        ConfigStore::open_with_paths(profile.path().join("config.sqlite3"), config_path).unwrap(),
    );
    let document = ash_config::DirConfigDocument {
        exec_policy: ash_config::DirExecPolicyConfig {
            rules: vec![ash_execpolicy::ExecPolicyRule::new(
                ash_execpolicy::ExecPolicyRuleId::new("dir-deny-shell"),
                ash_execpolicy::ExecPolicySelector::Any,
                ash_execpolicy::ExecPolicyEffect::Deny("directory restriction".into()),
            )],
        },
        ..Default::default()
    };
    let user = config.read_snapshot().unwrap();
    let scope = ash_config::DirConfigScope::new(dir.root().id());
    let resolved = ash_config::resolve_scoped_config(
        &user,
        Some(ash_config::DirConfigInput::new(
            &scope,
            ash_config::DirConfigRevision::INITIAL,
            &document,
        )),
    )
    .unwrap();
    let server = server()
        .with_config_store(config.clone())
        .with_env_config(&resolved.values)
        .with_local_env_host(None, host_policy())
        .unwrap();
    server
        .initialize_local_dir_root(
            dir.path.clone(),
            crate::local::InitialDirGrantPolicy::HostConfiguration,
        )
        .unwrap();
    let original_revision = server.turn_executor_snapshot().policy_revision();
    let assert_denied = |id: &str| {
        let registry = &server.local_env_host.as_ref().unwrap().tools.reloadable;
        let call = ash_protocol::ToolCall {
            id: ash_protocol::ToolCallId::new(id).unwrap(),
            name: ash_protocol::ToolName::new("shell-command").unwrap(),
            arguments: serde_json::json!({
                "program": std::env::current_exe().unwrap(), "arguments": [], "working_directory": "."
            }),
        };
        let review = registry.tools().prepare(&call).unwrap();
        assert!(matches!(
            registry
                .policy()
                .decide(&review, &ash_async_utils::CancellationSource::new().token())
                .unwrap(),
            ExecutionDecision::Block(ash_action_policy::BlockReason::DeterministicRule { reason, .. })
                if reason.contains("directory restriction")
        ));
    };
    assert_denied("before-disable");
    let mut connection = server.connection();
    let initialized = server.handle_json(&mut connection, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#);
    assert!(initialized.contains("\"result\""));
    for id in [2, 3] {
        let result: serde_json::Value = serde_json::from_str(
            &server.handle_json(
                &mut connection,
                &serde_json::json!({
                    "jsonrpc": "2.0", "id": id, "method": "grep/index/disableAndDelete",
                    "params": {"commandId": "disable-grep", "expectedRevision": user.revision.get()}
                })
                .to_string(),
            ),
        )
        .unwrap();
        assert!(result.get("error").is_none(), "{result}");
        assert_eq!(result["result"]["config"]["revision"], user.revision.get());
        assert_eq!(
            server.turn_executor_snapshot().policy_revision(),
            original_revision
        );
        assert_denied(&format!("after-disable-{id}"));
    }
    assert_eq!(config.read_snapshot().unwrap().revision, user.revision);
}

impl AppServer {
    pub(crate) fn test_action_policy_revision(&self) -> String {
        self.turn_executor_snapshot().policy_revision()
    }

    pub(crate) fn test_local_shell_policy_decision(
        &self,
    ) -> Result<ash_action_policy::ExecutionDecision, core_api::CoreError> {
        // Prepared calls retain their original policy generation; each probe is a new call.
        static NEXT_PROBE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let registry = &self.local_env_host.as_ref().unwrap().tools.reloadable;
        let call = ash_protocol::ToolCall {
            id: ash_protocol::ToolCallId::new(format!(
                "directory-config-policy-probe-{}",
                NEXT_PROBE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ))
            .unwrap(),
            name: ash_protocol::ToolName::new("shell-command").unwrap(),
            arguments: serde_json::json!({
                "program": std::env::current_exe().unwrap(), "arguments": [], "working_directory": "."
            }),
        };
        let review = registry.tools().prepare(&call)?;
        registry
            .policy()
            .decide(&review, &ash_async_utils::CancellationSource::new().token())
    }
}

#[cfg(unix)]
#[test]
fn failed_semantic_rebuild_preserves_tools_watcher_and_indexing_job() {
    let profile = tempfile::tempdir().unwrap();
    let dir = TestDir::new("semantic-rebuild", "source.rs");
    let models = crate::CodebaseModels::new(
        ash_codebase::EmbeddingIndexKey::new("rebuild-test-v1").unwrap(),
        Arc::new(PermissionBoundSemanticEmbedding),
    );
    let server = server()
        .with_state_runtime(Arc::new(
            ash_state::StateRuntime::open(profile.path()).unwrap(),
        ))
        .with_codebase_models(models)
        .with_local_env_host(None, host_policy())
        .unwrap();
    server
        .initialize_local_dir_root(
            dir.path.clone(),
            crate::local::InitialDirGrantPolicy::HostConfiguration,
        )
        .unwrap();
    let semantic = server.codebase_semantic_service().unwrap();
    let job = server.codebase_semantic_job().unwrap();
    let catalog = server.local_env_host.as_ref().unwrap().tools.definitions();
    let policy = server.turn_executor_snapshot().policy_revision();
    let codebase = server.codebase_service().unwrap();
    let path = codebase.store().database_path().unwrap().to_path_buf();
    let saved = path.with_extension("saved");
    // Unix permits renaming an open database. Existing services keep their connection,
    // while opening the replacement vector store fails against a directory at that path.
    std::fs::rename(&path, &saved).unwrap();
    std::fs::create_dir(&path).unwrap();
    let result = server
        .env_runtime_control()
        .unwrap()
        .reconcile_codebase_runtime();
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&saved, &path).unwrap();
    assert!(
        matches!(result, Err(EnvRuntimeError::Failed(message)) if message.contains("vector data"))
    );
    assert_eq!(
        server.local_env_host.as_ref().unwrap().tools.definitions(),
        catalog
    );
    assert_eq!(server.turn_executor_snapshot().policy_revision(), policy);
    assert!(Arc::ptr_eq(
        &semantic,
        &server.codebase_semantic_service().unwrap()
    ));
    assert!(Arc::ptr_eq(&job, &server.codebase_semantic_job().unwrap()));
    assert!(
        server
            .env_runtime
            .read()
            .unwrap()
            .workspace
            ._file_system_watcher
            .is_some()
    );
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_codebase_runtime()
        .unwrap();
    assert!(!Arc::ptr_eq(
        &semantic,
        &server.codebase_semantic_service().unwrap()
    ));
}

#[test]
fn semantic_rebuild_releases_directory_gate_before_joining_retired_watcher() {
    struct BlockedChanges {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl super::super::fs_watcher::SessionDirFileChangeSink for BlockedChanges {
        fn session_files_changed(
            &self,
            _: &SessionId,
            _: &Path,
            _: &ash_app_server_protocol::protocol::fs::FsChanged,
        ) {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
    }

    let dir = TestDir::new("retired-watcher", "source.rs");
    let server = Arc::new(server().with_local_env_host(None, host_policy()).unwrap());
    server
        .activate_local_dirs(vec![("folder".into(), dir.authorization())])
        .unwrap();
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let watcher = FileSystemWatcher::start_for_session_directory(
        dir.authorization().dir().clone(),
        Arc::clone(&server.updates),
        SessionId::new("blocked-watcher").unwrap(),
        Arc::new(BlockedChanges {
            entered,
            release: Mutex::new(release_rx),
        }),
    )
    .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let previous = server
        .env_runtime
        .write()
        .unwrap()
        .workspace
        ._file_system_watcher
        .replace(watcher);
    drop(previous);
    let tools = Arc::clone(&server.local_env_host.as_ref().unwrap().tools);
    let generation = tools.state.lock().unwrap().registry_generation;
    let control = server.env_runtime_control().unwrap();
    let rebuilding = std::thread::spawn(move || control.reconcile_codebase_runtime());
    let deadline = Instant::now() + Duration::from_secs(5);
    while tools.state.lock().unwrap().registry_generation == generation && Instant::now() < deadline
    {
        std::thread::yield_now();
    }
    let (bound, bound_rx) = std::sync::mpsc::channel();
    let binding_server = Arc::clone(&server);
    let authorization = dir.authorization();
    let binding = std::thread::spawn(move || {
        bound
            .send(binding_server.activate_local_dirs(vec![("folder".into(), authorization)]))
            .unwrap();
    });
    let result = bound_rx.recv_timeout(Duration::from_secs(5));
    // Release the owned worker before asserting so the failing version also exits cleanly.
    release.send(()).unwrap();
    rebuilding.join().unwrap().unwrap();
    binding.join().unwrap();
    assert!(
        result.is_ok(),
        "another window must bind while the retired watcher is busy"
    );
    result.unwrap().unwrap();
}

#[test]
fn directory_grants_protocol_requires_the_canonical_product_host_capability() {
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    let server = server().with_config_store(config);
    let next_request = AtomicUsize::new(1);
    let rpc = |connection: &mut ConnectionState, method: &str, params: serde_json::Value| {
        serde_json::from_str::<serde_json::Value>(
            &server.handle_json(
                connection,
                &serde_json::json!({
                    "jsonrpc":"2.0", "id":next_request.fetch_add(1, Ordering::Relaxed), "method":method, "params":params,
                })
                .to_string(),
            ),
        )
        .unwrap()
    };
    let initialize = |capabilities| serde_json::json!({"clientInfo":{"name":"fixture","version":"1"}, "capabilities":capabilities});
    let mut untrusted = server.connection();
    assert_eq!(
        rpc(
            &mut untrusted,
            "initialize",
            initialize(serde_json::json!({"directoryGrantsHost":{"version":1}}))
        )["error"]["message"],
        "PermissionRequired"
    );
    let mut invalid = server.product_host_connection();
    assert_eq!(
        rpc(
            &mut invalid,
            "initialize",
            initialize(serde_json::json!({"directoryGrantsHost":{"version":2}}))
        )["error"]["code"],
        -32602
    );
    for capabilities in [
        serde_json::json!({}),
        serde_json::json!({"dirPermissionsHost":{"version":1}}),
    ] {
        let mut connection = server.product_host_connection();
        assert!(
            rpc(&mut connection, "initialize", initialize(capabilities))
                .get("error")
                .is_none()
        );
        assert_eq!(
            rpc(
                &mut connection,
                "config/directoryGrants/list",
                serde_json::json!({})
            )["error"]["message"],
            "PermissionRequired"
        );
    }
    let mut product = server.product_host_connection();
    assert!(
        rpc(
            &mut product,
            "initialize",
            initialize(serde_json::json!({"directoryGrantsHost":{"version":1}}))
        )
        .get("error")
        .is_none()
    );
    assert_eq!(
        rpc(
            &mut product,
            "config/directoryGrants/list",
            serde_json::json!({})
        )["result"]["entries"],
        serde_json::json!([])
    );
    for action in ["read", "list", "set", "forget"] {
        assert_eq!(
            rpc(
                &mut product,
                &format!("config/dirPermissions/{action}"),
                serde_json::json!({})
            )["error"]["code"],
            -32601
        );
    }
}

#[test]
fn directory_grants_protocol_preserves_legacy_profiles_precise_grants_and_revisions() {
    let dir = TestDir::new("canonical-directory-grants", "readable.txt");
    let root = dir.root();
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("config.sqlite3");
    // The storage key remains compatible although all live RPC names change.
    std::fs::write(database.with_extension("toml"), format!("schemaVersion = 10\n[dirPermissions.entries]\n\"{}\" = [\"readFiles\", \"useLanguageServices\"]\n", root.id())).unwrap();
    let config = Arc::new(ConfigStore::open(&database).unwrap());
    let server = server().with_config_store(Arc::clone(&config));
    let mut connection = server.product_host_connection();
    let next_request = AtomicUsize::new(1);
    let rpc = |connection: &mut ConnectionState, method: &str, params: serde_json::Value| {
        serde_json::from_str::<serde_json::Value>(
            &server.handle_json(
                connection,
                &serde_json::json!({
                    "jsonrpc":"2.0", "id":next_request.fetch_add(1, Ordering::Relaxed), "method":method, "params":params,
                })
                .to_string(),
            ),
        )
        .unwrap()
    };
    assert!(rpc(&mut connection, "initialize", serde_json::json!({"clientInfo":{"name":"fixture","version":"1"},"capabilities":{"directoryGrantsHost":{"version":1}}})).get("error").is_none());
    let listed = rpc(
        &mut connection,
        "config/directoryGrants/list",
        serde_json::json!({}),
    );
    assert_eq!(
        listed["result"]["entries"][0]["permissions"],
        serde_json::json!(["readFiles", "useLanguageServices"])
    );
    let revision = listed["result"]["revision"].as_u64().unwrap();
    let read = rpc(
        &mut connection,
        "config/directoryGrants/read",
        serde_json::json!({"path":dir.path.join(".")}),
    );
    assert_eq!(read["result"]["dir"], root.id().to_string());
    assert_eq!(
        read["result"]["permissions"],
        listed["result"]["entries"][0]["permissions"]
    );
    let invalid = rpc(
        &mut connection,
        "config/directoryGrants/set",
        serde_json::json!({"commandId":"invalid-grant","expectedRevision":revision,"path":dir.path,"permissions":["futurePermission"]}),
    );
    assert_eq!(invalid["error"]["code"], -32602);
    assert_eq!(config.read_snapshot().unwrap().revision.get(), revision);
    for (command_id, path, permissions) in [
        (
            "duplicate-capabilities",
            dir.path.clone(),
            serde_json::json!(["readFiles", "readFiles"]),
        ),
        (
            "relative-profile-path",
            PathBuf::from("relative"),
            serde_json::json!(["readFiles"]),
        ),
        (
            "empty-profile-path",
            PathBuf::new(),
            serde_json::json!(["readFiles"]),
        ),
    ] {
        let invalid = rpc(
            &mut connection,
            "config/directoryGrants/set",
            serde_json::json!({
                "commandId":command_id, "expectedRevision":revision, "path":path, "permissions":permissions,
            }),
        );
        assert_eq!(invalid["error"]["code"], -32602);
        assert_eq!(config.read_snapshot().unwrap().revision.get(), revision);
    }
    let permissions = serde_json::json!(["readFiles", "executeCommands", "useLanguageServices"]);
    let request = serde_json::json!({"commandId":"set-precise-grant","expectedRevision":revision,"path":dir.path,"permissions":permissions});
    let saved = rpc(
        &mut connection,
        "config/directoryGrants/set",
        request.clone(),
    );
    assert_eq!(saved["result"]["disposition"], "updated");
    let saved_revision = saved["result"]["revision"].as_u64().unwrap();
    let replayed = rpc(&mut connection, "config/directoryGrants/set", request);
    assert_eq!(replayed["result"]["disposition"], "replayed");
    assert_eq!(replayed["result"]["revision"], saved_revision);
    assert_eq!(
        rpc(
            &mut connection,
            "config/directoryGrants/read",
            serde_json::json!({"path":dir.path})
        )["result"]["permissions"],
        permissions
    );
    let stale = rpc(
        &mut connection,
        "config/directoryGrants/set",
        serde_json::json!({"commandId":"stale-grant","expectedRevision":revision,"path":dir.path,"permissions":[]}),
    );
    assert_eq!(stale["error"]["message"], "ConfigRevisionConflict");
    assert_eq!(
        config.read_snapshot().unwrap().revision.get(),
        saved_revision
    );
    let empty = rpc(
        &mut connection,
        "config/directoryGrants/set",
        serde_json::json!({"commandId":"empty-grant","expectedRevision":saved_revision,"path":dir.path,"permissions":[]}),
    );
    let empty_revision = empty["result"]["revision"].as_u64().unwrap();
    assert_eq!(
        rpc(
            &mut connection,
            "config/directoryGrants/read",
            serde_json::json!({"path":dir.path})
        )["result"]["permissions"],
        serde_json::json!([])
    );
    assert_eq!(
        rpc(
            &mut connection,
            "config/directoryGrants/forget",
            serde_json::json!({"commandId":"forget-grant","expectedRevision":empty_revision,"dir":root.id()})
        )["result"]["disposition"],
        "updated"
    );
    assert!(
        rpc(
            &mut connection,
            "config/directoryGrants/read",
            serde_json::json!({"path":dir.path})
        )["result"]
            .get("permissions")
            .is_none()
    );
    assert!(
        rpc(
            &mut connection,
            "config/directoryGrants/list",
            serde_json::json!({})
        )["result"]["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let persisted = std::fs::read_to_string(database.with_extension("toml")).unwrap();
    assert!(persisted.contains("[directoryGrants"));
    assert!(!persisted.contains("dirPermissions"));
}

#[test]
fn precise_language_and_watcher_grants_are_enforced_by_the_backend() {
    let directory = TestDir::new("precise-runtime-grants", "main.rs");
    let config = Arc::new(ConfigStore::open(directory.path.join("config.sqlite3")).unwrap());
    let grant = |id: &str, permissions| {
        config
            .apply(ConfigCommandRequest {
                command_id: CommandId::new(id).unwrap(),
                expected_revision: config.read_snapshot().unwrap().revision,
                command: UserConfigCommand::SetDirectoryGrant {
                    dir: directory.root().id(),
                    permissions,
                    display_path: None,
                },
            })
            .unwrap();
    };
    grant(
        "execute-without-language",
        Permissions::new([
            Permission::ReadFiles,
            Permission::SearchFiles,
            Permission::BrowseFiles,
            Permission::InspectRepository,
            Permission::ExecuteCommands,
        ]),
    );
    let server = server()
        .with_config_store(config.clone())
        .with_local_env_host(None, DirGrantPolicy::UserConfig(config.clone()))
        .unwrap();
    server
        .switch_local_dir_root(directory.path.clone())
        .unwrap();
    assert!(server.language_dir_root_for(None, None).is_err());
    server
        .env_runtime_control()
        .unwrap()
        .reconcile_codebase_runtime()
        .unwrap();
    assert!(
        server
            .env_runtime
            .read()
            .unwrap()
            .workspace
            ._file_system_watcher
            .is_none()
    );
    grant(
        "allow-language",
        Permissions::new([
            Permission::ReadFiles,
            Permission::SearchFiles,
            Permission::BrowseFiles,
            Permission::InspectRepository,
            Permission::ExecuteCommands,
            Permission::UseLanguageServices,
        ]),
    );
    server
        .environment_processor()
        .reconcile_active_directory_grant()
        .unwrap();
    assert!(server.language_dir_root_for(None, None).is_ok());
    grant(
        "revoke-language",
        Permissions::new([Permission::ReadFiles, Permission::ExecuteCommands]),
    );
    server
        .environment_processor()
        .reconcile_active_directory_grant()
        .unwrap();
    assert!(server.language_dir_root_for(None, None).is_err());
    let runtime = server.env_runtime.read().unwrap();
    assert!(runtime.workspace.codebase.is_none());
    assert!(runtime.workspace.symbol_index.is_none());
    assert!(runtime.workspace.cloud_codebase.is_none());
}

struct PermissionRequestModel {
    extra: std::path::PathBuf,
    requests: Mutex<Vec<ash_protocol::ModelRequest>>,
}

impl core_api::ModelService for PermissionRequestModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        _: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        let mut requests = self.requests.lock().unwrap();
        let step = requests.len();
        requests.push(request.clone());
        let output = match step {
            0 => vec![ash_protocol::ResponseItem::ToolCall(
                ash_protocol::ToolCall {
                    id: ash_protocol::ToolCallId::new("request-extra-permissions").unwrap(),
                    name: ash_protocol::ToolName::new("request_permissions").unwrap(),
                    arguments: serde_json::json!({"duration":"session","directories":[{"path":self.extra,"permissions":["readFiles","writeFiles"]}],"network_hosts":[],"reason":"Read the selected extra directory"}),
                },
            )],
            1 => vec![ash_protocol::ResponseItem::ToolCall(
                ash_protocol::ToolCall {
                    id: ash_protocol::ToolCallId::new("read-approved-extra").unwrap(),
                    name: ash_protocol::ToolName::new("read_file").unwrap(),
                    arguments: serde_json::json!({"path":self.extra.join("file"),"offset":null,"limit":null}),
                },
            )],
            2 => vec![ash_protocol::ResponseItem::ToolCall(
                ash_protocol::ToolCall {
                    id: ash_protocol::ToolCallId::new("write-unapproved-extra").unwrap(),
                    name: ash_protocol::ToolName::new("write_file").unwrap(),
                    arguments: serde_json::json!({"path":self.extra.join("file"),"content":"unauthorized"}),
                },
            )],
            _ => vec![ash_protocol::ResponseItem::Text("done".into())],
        };
        Ok(ash_protocol::ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason: ash_protocol::StopReason::Completed,
        })
    }
}

#[test]
fn permission_requests_follow_core_interaction_enforce_subset_and_expire_on_completion() {
    let main = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    std::fs::write(extra.path().join("file"), "approved read").unwrap();
    let model = Arc::new(PermissionRequestModel {
        extra: extra.path().to_path_buf(),
        requests: Mutex::new(Vec::new()),
    });
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let server = AppServer::new(threads, model.clone())
        .with_ephemeral_env_state()
        .with_local_env_host(None, host_policy())
        .unwrap();
    server
        .switch_local_dir_root(main.path().to_path_buf())
        .unwrap();
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("permission-create-thread").unwrap(),
            title: "permissions".into(),
        })
        .unwrap();
    let executor = server.turn_executor_snapshot();
    let turn = server
        .admit_bound_turn(
            &thread.thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("permission-start").unwrap(),
                expected_sequence: SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                policy_revision: executor.policy_revision(),
                approval_mode: ash_protocol::ApprovalMode::BypassPermissions,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: Some(executor.tool_profile_snapshot().unwrap()),
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "Read the extra directory".into(),
                }],
            },
            None,
            crate::client_host::TextDocumentMode::FileSystem,
        )
        .unwrap()
        .turn_id;
    executor.start(&thread.thread_id, &turn).unwrap();
    let wait = |status| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = server.threads.read_thread(&thread.thread_id).unwrap();
            if snapshot.turns.last().unwrap().status == status {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "permission Turn did not reach {status:?}: {:?}",
                snapshot.turns.last().unwrap()
            );
            std::thread::yield_now();
        }
    };
    let waiting = wait(ash_protocol::TurnStatus::WaitingForUserInput);
    let interaction = waiting
        .turns
        .last()
        .unwrap()
        .pending_interaction
        .as_ref()
        .unwrap();
    let ash_protocol::AgentRequest::Permissions { request } = &interaction.request else {
        panic!("Core must expose a permission request");
    };
    let invalid = ash_protocol::PermissionResponse {
        duration: ash_protocol::PermissionGrantDuration::Session,
        directories: vec![ash_protocol::RequestedDirectoryGrant {
            path: request.directories[0].path.clone(),
            permissions: vec![Permission::ExecuteCommands],
        }],
        network_hosts: Vec::new(),
    };
    let respond = |id: &str, response| {
        server.threads.resolve_turn_interaction(
            &thread.thread_id,
            core_api::ResolveTurnInteractionRequest {
                turn_id: turn.clone(),
                command_id: CommandId::new(id).unwrap(),
                expected_sequence: SequenceExpectation::Any,
                request_id: interaction.request_id.clone(),
                response: ash_protocol::AgentResponse::Permissions { response },
            },
        )
    };
    assert!(respond("permission-invalid", invalid).is_err());
    respond(
        "permission-subset",
        ash_protocol::PermissionResponse {
            duration: ash_protocol::PermissionGrantDuration::Turn,
            directories: vec![ash_protocol::RequestedDirectoryGrant {
                path: request.directories[0].path.clone(),
                permissions: vec![Permission::ReadFiles],
            }],
            network_hosts: Vec::new(),
        },
    )
    .unwrap();
    let completed = wait(ash_protocol::TurnStatus::Completed);
    let results = serde_json::to_string(&completed.items).unwrap();
    assert!(results.contains("approved read"), "{results}");
    assert!(
        results.contains("outside the authorized directories")
            || results.contains("directory permission required")
    );
    assert_eq!(
        std::fs::read_to_string(extra.path().join("file")).unwrap(),
        "approved read"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if server
            .env_runtime
            .read()
            .unwrap()
            .dir_grants
            .requested_authorizations(
                &completed.session_id,
                &thread.thread_id,
                &turn,
                Permission::ReadFiles,
            )
            .is_empty()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "completed Turn did not revoke its permission leases"
        );
        std::thread::yield_now();
    }
}

#[cfg(unix)]
struct ReusableApprovalModel {
    step: Mutex<usize>,
}
#[cfg(unix)]
impl core_api::ModelService for ReusableApprovalModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ash_protocol::ModelRequest,
        _: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        let mut step = self.step.lock().unwrap();
        let output = if *step < 3 {
            vec![ash_protocol::ResponseItem::ToolCall(
                ash_protocol::ToolCall {
                    id: ash_protocol::ToolCallId::new(format!("reusable-action-{}", *step))
                        .unwrap(),
                    name: ash_protocol::ToolName::new("environment").unwrap(),
                    arguments: serde_json::json!({"environment":"worker", "operation":{"type":"command","program":"/bin/echo", "arguments":[if *step < 2 { "same" } else { "different" }], "cwd":".", "timeout_millis":10000}}),
                },
            )]
        } else {
            vec![ash_protocol::ResponseItem::Text("done".into())]
        };
        *step += 1;
        Ok(ash_protocol::ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason: ash_protocol::StopReason::Completed,
        })
    }
}

#[cfg(unix)]
#[test]
fn reusable_approvals_follow_core_and_bind_the_exact_action() {
    for decision in [
        ash_protocol::ActionApprovalDecision::ApproveForSession,
        ash_protocol::ActionApprovalDecision::ApproveAndSaveRule,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(ConfigStore::open(directory.path().join("config.db")).unwrap());
        let model = Arc::new(ReusableApprovalModel {
            step: Mutex::new(0),
        });
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let server = AppServer::new(threads, model)
            .with_ephemeral_env_state()
            .with_config_store(store.clone())
            .with_local_env_host(None, host_policy())
            .unwrap();
        server
            .activate_local_dirs(vec![(
                "primary".into(),
                Grant::for_environment(
                    Dir::open_local(directory.path()).unwrap(),
                    GrantSource::HostConfiguration,
                    Permissions::new([
                        Permission::ReadFiles,
                        Permission::WriteFiles,
                        Permission::BrowseFiles,
                        Permission::ExecuteCommands,
                    ]),
                ),
            )])
            .unwrap();
        let environment = Arc::new(
            exec_server::LocalEnvironment::open(
                "worker".into(),
                directory.path(),
                exec_server_protocol::FileAccess::ReadWrite,
                exec_server_protocol::NetworkAccess::Denied,
                Arc::new(mxc_sandbox::MxcSandbox::new(
                    ash_install_context::InstallContext::current(),
                )),
            )
            .unwrap(),
        );
        let server = server
            .with_execution_environments(vec![exec_server::ExecutionEnvironment::Local(
                environment,
            )])
            .unwrap();
        let thread = server
            .start_thread(StartThreadRequest {
                execution_target: None,
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new("reusable-thread").unwrap(),
                title: "approvals".into(),
            })
            .unwrap();
        let executor = server.turn_executor_snapshot();
        let turn = server
            .admit_bound_turn(
                &thread.thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: CommandId::new("reusable-turn").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: executor.policy_revision(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: Some(executor.tool_profile_snapshot().unwrap()),
                    activated_skills: vec![],
                    input: vec![UserInput::Text {
                        text: "Run exact actions".into(),
                    }],
                },
                None,
                crate::client_host::TextDocumentMode::FileSystem,
            )
            .unwrap()
            .turn_id;
        let wait = |status| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let snapshot = server.threads.read_thread(&thread.thread_id).unwrap();
                if snapshot.turns.last().unwrap().status == status {
                    break snapshot;
                }
                assert!(
                    Instant::now() < deadline,
                    "approval Turn did not reach {status:?}: {:?}",
                    snapshot
                        .items
                        .iter()
                        .filter(|item| matches!(item, ash_protocol::ThreadItem::ToolResult { .. }))
                        .collect::<Vec<_>>()
                );
                std::thread::yield_now();
            }
        };
        executor.start(&thread.thread_id, &turn).unwrap();
        let waiting = wait(ash_protocol::TurnStatus::WaitingForApproval);
        let interaction = waiting
            .turns
            .last()
            .unwrap()
            .pending_interaction
            .as_ref()
            .unwrap();
        let ash_protocol::AgentRequest::Approval { request } = &interaction.request else {
            panic!("expected approval");
        };
        assert!(request.allowed_decisions.contains(&decision));
        assert_eq!(request.command.as_ref().unwrap().program, "/bin/echo");
        server
            .threads
            .resolve_turn_interaction(
                &thread.thread_id,
                core_api::ResolveTurnInteractionRequest {
                    turn_id: turn.clone(),
                    command_id: CommandId::new("reusable-approve").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    request_id: interaction.request_id.clone(),
                    response: ash_protocol::AgentResponse::Approval {
                        response: ash_protocol::ActionApprovalResponse { decision },
                    },
                },
            )
            .unwrap();
        executor.resume(&thread.thread_id, &turn).unwrap();
        let waiting = wait(ash_protocol::TurnStatus::WaitingForApproval);
        let interaction = waiting
            .turns
            .last()
            .unwrap()
            .pending_interaction
            .as_ref()
            .unwrap();
        let ash_protocol::AgentRequest::Approval { request } = &interaction.request else {
            panic!("expected changed-action approval");
        };
        assert_eq!(request.command.as_ref().unwrap().arguments, ["different"]);
        assert_eq!(
            waiting.started_tool_calls.len(),
            2,
            "same action must reuse the exact approved authority"
        );
        if decision == ash_protocol::ActionApprovalDecision::ApproveAndSaveRule {
            assert_eq!(store.committed_snapshot().values.exec_policy.rules.len(), 1);
        } else {
            assert!(
                store
                    .committed_snapshot()
                    .values
                    .exec_policy
                    .rules
                    .is_empty()
            );
        }
        server
            .threads
            .resolve_turn_interaction(
                &thread.thread_id,
                core_api::ResolveTurnInteractionRequest {
                    turn_id: turn.clone(),
                    command_id: CommandId::new("reusable-decline").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    request_id: interaction.request_id.clone(),
                    response: ash_protocol::AgentResponse::Approval {
                        response: ash_protocol::ActionApprovalResponse {
                            decision: ash_protocol::ActionApprovalDecision::Decline,
                        },
                    },
                },
            )
            .unwrap();
        executor.resume(&thread.thread_id, &turn).unwrap();
        let complete = wait(ash_protocol::TurnStatus::Completed);
        assert_eq!(complete.started_tool_calls.len(), 2);
    }
}

#[cfg(unix)]
struct RemoteNetworkModel {
    url: String,
    step: Mutex<usize>,
}
#[cfg(unix)]
impl core_api::ModelService for RemoteNetworkModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ash_protocol::ModelRequest,
        _: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        let mut step = self.step.lock().unwrap();
        let output = if *step == 0 {
            vec![ash_protocol::ResponseItem::ToolCall(
                ash_protocol::ToolCall {
                    id: ash_protocol::ToolCallId::new("remote-network-command").unwrap(),
                    name: ash_protocol::ToolName::new("environment").unwrap(),
                    arguments: serde_json::json!({"environment":"network-worker", "operation":{"type":"command","program":"/usr/bin/curl",
                "arguments":["--silent","--show-error","--max-time","15",self.url], "cwd":".", "timeout_millis":20000}}),
                },
            )]
        } else {
            vec![ash_protocol::ResponseItem::Text("done".into())]
        };
        *step += 1;
        Ok(ash_protocol::ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason: ash_protocol::StopReason::Completed,
        })
    }
}

#[cfg(unix)]
#[test]
fn remote_network_connections_require_the_exact_core_approval_before_upstream_io() {
    use std::io::Read;
    use std::io::Write;
    for allow in [false, true] {
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let address = target.local_addr().unwrap();
        let contacted = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        let target_contacts = contacted.clone();
        let target_stopped = stopped.clone();
        let target_worker = std::thread::spawn(move || {
            while !target_stopped.load(Ordering::SeqCst) {
                match target.accept() {
                    Ok((mut connection, _)) => {
                        target_contacts.fetch_add(1, Ordering::SeqCst);
                        connection
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let mut bytes = [0; 4096];
                        let _ = connection.read(&mut bytes);
                        connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nremote-approved").unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("target listener failed: {error}"),
                }
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(ConfigStore::open(directory.path().join("config.db")).unwrap());
        store
            .apply(ConfigCommandRequest {
                command_id: CommandId::new("require-network-approval").unwrap(),
                expected_revision: ConfigRevision::new(0),
                command: UserConfigCommand::UpsertExecPolicyRule {
                    rule: ash_execpolicy::ExecPolicyRule::new(
                        ash_execpolicy::ExecPolicyRuleId::new("observed-target"),
                        ash_execpolicy::ExecPolicySelector::Network {
                            protocol: None,
                            host: ash_execpolicy::HostMatcher::exact("127.0.0.1"),
                            port: Some(address.port()),
                        },
                        ash_execpolicy::ExecPolicyEffect::RequireApproval,
                    ),
                },
            })
            .unwrap();
        let threads = Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        )));
        let server = AppServer::new(
            threads,
            Arc::new(RemoteNetworkModel {
                url: format!("http://{address}/"),
                step: Mutex::new(0),
            }),
        )
        .with_ephemeral_env_state()
        .with_config_store(store)
        .with_local_env_host(None, host_policy())
        .unwrap();
        server
            .activate_local_dirs(vec![(
                "primary".into(),
                Grant::for_environment(
                    Dir::open_local(directory.path()).unwrap(),
                    GrantSource::HostConfiguration,
                    Permissions::new([
                        Permission::ReadFiles,
                        Permission::WriteFiles,
                        Permission::BrowseFiles,
                        Permission::ExecuteCommands,
                    ]),
                ),
            )])
            .unwrap();
        let environment = Arc::new(
            exec_server::LocalEnvironment::open(
                "network-worker".into(),
                directory.path(),
                exec_server_protocol::FileAccess::ReadWrite,
                exec_server_protocol::NetworkAccess::Allowed,
                Arc::new(mxc_sandbox::MxcSandbox::new(
                    ash_install_context::InstallContext::current(),
                )),
            )
            .unwrap(),
        );
        let token = "b2".repeat(32);
        let listener =
            exec_server::ExecListener::bind("127.0.0.1:0".parse().unwrap(), &token, environment)
                .unwrap();
        let client = exec_server::ExecClient::connect(
            exec_server::RemoteEndpoint::new(listener.address(), token).unwrap(),
        )
        .unwrap();
        let server = server
            .with_execution_environments(vec![exec_server::ExecutionEnvironment::Remote(client)])
            .unwrap();
        let thread = server
            .start_thread(StartThreadRequest {
                execution_target: None,
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new("remote-network-thread").unwrap(),
                title: "network".into(),
            })
            .unwrap();
        let executor = server.turn_executor_snapshot();
        let turn = server
            .admit_bound_turn(
                &thread.thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: CommandId::new("remote-network-turn").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: executor.policy_revision(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: Some(executor.tool_profile_snapshot().unwrap()),
                    activated_skills: vec![],
                    input: vec![UserInput::Text {
                        text: "Contact this target".into(),
                    }],
                },
                None,
                crate::client_host::TextDocumentMode::FileSystem,
            )
            .unwrap()
            .turn_id;
        let wait = |status| {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let snapshot = server.threads.read_thread(&thread.thread_id).unwrap();
                if snapshot.turns.last().unwrap().status == status {
                    break snapshot;
                }
                assert!(
                    Instant::now() < deadline,
                    "network Turn did not reach {status:?}: {:?}",
                    snapshot
                        .items
                        .iter()
                        .filter(|item| matches!(item, ash_protocol::ThreadItem::ToolResult { .. }))
                        .collect::<Vec<_>>()
                );
                std::thread::yield_now();
            }
        };
        let respond = |command: &str, request_id: ash_protocol::RequestId, decision| {
            server
                .threads
                .resolve_turn_interaction(
                    &thread.thread_id,
                    core_api::ResolveTurnInteractionRequest {
                        turn_id: turn.clone(),
                        command_id: CommandId::new(command).unwrap(),
                        expected_sequence: SequenceExpectation::Any,
                        request_id,
                        response: ash_protocol::AgentResponse::Approval {
                            response: ash_protocol::ActionApprovalResponse { decision },
                        },
                    },
                )
                .unwrap()
        };
        executor.start(&thread.thread_id, &turn).unwrap();
        let initial = wait(ash_protocol::TurnStatus::WaitingForApproval);
        respond(
            "approve-process",
            initial
                .turns
                .last()
                .unwrap()
                .pending_interaction
                .as_ref()
                .unwrap()
                .request_id
                .clone(),
            ash_protocol::ActionApprovalDecision::ApproveOnce,
        );
        executor.resume(&thread.thread_id, &turn).unwrap();
        let pending = wait(ash_protocol::TurnStatus::WaitingForApproval);
        let interaction = pending
            .turns
            .last()
            .unwrap()
            .pending_interaction
            .as_ref()
            .unwrap();
        let ash_protocol::AgentRequest::Approval { request } = &interaction.request else {
            panic!("network approval required");
        };
        assert_eq!(request.capabilities.len(), 1);
        assert_eq!(
            request.capabilities[0].kind,
            ash_protocol::ActionApprovalCapabilityKind::Network
        );
        assert!(request.capabilities[0].scope.contains(&address.to_string()));
        assert_eq!(
            contacted.load(Ordering::SeqCst),
            0,
            "proxy must not connect upstream before the exact approval"
        );
        respond(
            "resolve-network",
            interaction.request_id.clone(),
            if allow {
                ash_protocol::ActionApprovalDecision::ApproveOnce
            } else {
                ash_protocol::ActionApprovalDecision::Decline
            },
        );
        let completed = wait(ash_protocol::TurnStatus::Completed);
        let output = serde_json::to_string(&completed.items).unwrap();
        assert_eq!(contacted.load(Ordering::SeqCst), usize::from(allow));
        assert_eq!(output.contains("remote-approved"), allow);
        stopped.store(true, Ordering::SeqCst);
        target_worker.join().unwrap();
    }
}

#[test]
fn capability_scoped_directory_startup_keeps_repository_watching_and_indexing_optional() {
    let primary = TestDir::new("command-only-primary", "main.rs");
    let secondary = TestDir::new("inspect-only-secondary", "other.rs");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let command_grant = || {
        Grant::for_environment(
            primary.root(),
            GrantSource::HostConfiguration,
            Permissions::new([
                Permission::ReadFiles,
                Permission::BrowseFiles,
                Permission::ExecuteCommands,
            ]),
        )
    };
    server
        .activate_local_dirs(vec![
            ("primary".into(), command_grant()),
            (
                "secondary".into(),
                Grant::for_environment(
                    secondary.root(),
                    GrantSource::HostConfiguration,
                    Permissions::new([
                        Permission::ReadFiles,
                        Permission::BrowseFiles,
                        Permission::InspectRepository,
                    ]),
                ),
            ),
        ])
        .unwrap();
    {
        let runtime = server.env_runtime.read().unwrap();
        assert!(runtime.workspace.git.is_some());
        assert!(runtime.workspace._git_watcher.is_none());
        assert!(runtime.workspace.codebase.is_none());
        assert!(runtime.workspace.symbol_index.is_none());
        assert!(runtime.workspace._file_system_watcher.is_none());
    }
    server
        .activate_local_dirs(vec![("primary".into(), command_grant())])
        .unwrap();
    assert!(server.env_runtime.read().unwrap().workspace.git.is_none());
    server
        .commit_limited_dir_runtime(
            Grant::for_environment(
                primary.root(),
                GrantSource::HostConfiguration,
                Permissions::new([Permission::ReadFiles, Permission::BrowseFiles]),
            ),
            server.local_env_host.as_ref().unwrap(),
        )
        .unwrap();
    let runtime = server.env_runtime.read().unwrap();
    assert!(runtime.workspace.codebase.is_none());
    assert!(runtime.workspace.symbol_index.is_none());
}

fn start_directory_approval(server: &AppServer) -> ash_protocol::ThreadId {
    let thread = server
        .start_thread(StartThreadRequest {
            execution_target: None,
            branch_name: None,
            agent_id: None,
            agent: None,
            command_id: CommandId::new("directory-reopen-thread").unwrap(),
            title: "pending directory".into(),
        })
        .unwrap();
    let turn = server
        .threads
        .start_turn(
            &thread.thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("directory-reopen-turn").unwrap(),
                expected_sequence: SequenceExpectation::Exact(1),
                model: None,
                reasoning_effort: None,
                policy_revision: "directory-policy".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![UserInput::Text {
                    text: "keep the pending approval".into(),
                }],
            },
        )
        .unwrap();
    server
        .threads
        .request_turn_interaction(
            &thread.thread_id,
            &turn.turn_id,
            ash_core::RequestTurnInteraction {
                request_id: ash_protocol::RequestId::new("directory-reopen-approval").unwrap(),
                item_id: None,
                request: ash_protocol::AgentRequest::Approval {
                    request: ash_protocol::ActionApprovalRequest {
                        action_digest: "a".repeat(64),
                        policy_revision: "directory-policy".into(),
                        capabilities: vec![ash_protocol::ActionApprovalCapability {
                            kind: ash_protocol::ActionApprovalCapabilityKind::Network,
                            scope: "example.test".into(),
                        }],
                        reason: "directory reopen regression".into(),
                        sandbox_denial: None,
                        allowed_decisions: vec![
                            ash_protocol::ActionApprovalDecision::ApproveOnce,
                            ash_protocol::ActionApprovalDecision::Decline,
                        ],
                        command: None,
                    },
                },
                deadline: None,
            },
        )
        .unwrap();
    thread.thread_id
}

#[test]
fn env_dirs_set_is_idempotent_while_approval_pending() {
    let first = TestDir::new("directory-reopen", "first.txt");
    let other = TestDir::new("directory-change", "other.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    let mut connection = server.product_host_connection();
    server.handle_json(
        &mut connection,
        &serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize", "params": {
                "clientInfo":{"name":"directory-reopen-test","version":"1"},
                "capabilities":{"directoryGrantsHost":{"version":1}}
            }
        })
        .to_string(),
    );
    let mut request = serde_json::json!({
        "jsonrpc":"2.0", "id":2, "method":"env/dirs/set", "params":{"dirs":[{
            "id":"folder", "path":first.path, "grant":{"type":"host","permissions":[
                "readFiles","writeFiles","executeCommands","watchFiles","browseFiles","searchFiles",
                "loadInstructions","loadConfig","discoverSkills","discoverMcp","useLanguageServices",
                "discoverHooks","discoverPlugins","inspectRepository","mutateRepository"
            ]}
        }]}
    });
    let initial: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut connection, &request.to_string())).unwrap();
    assert!(initial.get("error").is_none(), "{initial}");
    let files = server.file_system_service_for(Some("folder")).unwrap();
    let git = server
        .env_runtime
        .read()
        .unwrap()
        .workspace
        .git
        .clone()
        .unwrap();
    let thread_id = start_directory_approval(&server);
    let before = server.threads.read_thread(&thread_id).unwrap();
    assert_eq!(
        before.turns.last().unwrap().status,
        TurnStatus::WaitingForApproval
    );

    request["id"] = serde_json::json!(3);
    let repeated: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut connection, &request.to_string())).unwrap();
    assert!(
        repeated.get("error").is_none(),
        "same authorized directory must reopen while approval is pending: {repeated}"
    );
    assert_eq!(repeated["result"], initial["result"]);
    assert!(Arc::ptr_eq(
        &files,
        &server.file_system_service_for(Some("folder")).unwrap()
    ));
    assert!(Arc::ptr_eq(
        &git,
        server
            .env_runtime
            .read()
            .unwrap()
            .workspace
            .git
            .as_ref()
            .unwrap()
    ));

    let revoked = first.authorization();
    revoked.revoke();
    for changed in [
        Vec::new(),
        vec![("folder".into(), revoked)],
        vec![("folder".into(), other.authorization())],
        vec![(
            "folder".into(),
            Grant::for_environment(
                first.root(),
                GrantSource::HostConfiguration,
                Permissions::new([Permission::ReadFiles]),
            ),
        )],
        vec![(
            "folder".into(),
            Grant::for_environment(
                first.root(),
                GrantSource::ExplicitUser,
                host_directory_capabilities(),
            ),
        )],
    ] {
        assert_eq!(
            server.activate_local_dirs(changed),
            Err(EnvRuntimeError::Busy)
        );
    }
    let after = server.threads.read_thread(&thread_id).unwrap();
    assert_eq!(after.sequence, before.sequence);
    assert_eq!(
        after.turns.last().unwrap().pending_interaction,
        before.turns.last().unwrap().pending_interaction
    );
    assert_eq!(
        after.turns.last().unwrap().status,
        TurnStatus::WaitingForApproval
    );
    assert!(Arc::ptr_eq(
        &files,
        &server.file_system_service_for(Some("folder")).unwrap()
    ));
}

#[test]
fn env_dirs_set_retains_existing_aliases_without_switching_pending_primary() {
    let first = TestDir::new("directory-alias-first", "first.txt");
    let second = TestDir::new("directory-alias-second", "second.txt");
    let server = server().with_local_env_host(None, host_policy()).unwrap();
    server
        .activate_local_dirs(vec![
            ("workbench".into(), first.authorization()),
            ("second".into(), second.authorization()),
        ])
        .unwrap();
    let initial = server
        .activate_local_dirs(vec![
            ("sessions".into(), first.authorization()),
            ("second".into(), second.authorization()),
        ])
        .unwrap();
    let workbench_files = server.file_system_service_for(Some("workbench")).unwrap();
    let sessions_files = server.file_system_service_for(Some("sessions")).unwrap();
    let thread_id = start_directory_approval(&server);
    let repeated = server.activate_local_dirs(vec![
        ("sessions".into(), first.authorization()),
        ("second".into(), second.authorization()),
    ]);
    assert_eq!(repeated, Ok(initial));
    assert!(Arc::ptr_eq(
        &workbench_files,
        &server.file_system_service_for(Some("workbench")).unwrap()
    ));
    assert!(Arc::ptr_eq(
        &sessions_files,
        &server.file_system_service_for(Some("sessions")).unwrap()
    ));
    assert_eq!(
        server.activate_local_dirs(vec![
            ("second".into(), second.authorization()),
            ("sessions".into(), first.authorization())
        ]),
        Err(EnvRuntimeError::Busy)
    );
    assert_eq!(
        server
            .threads
            .read_thread(&thread_id)
            .unwrap()
            .turns
            .last()
            .unwrap()
            .status,
        TurnStatus::WaitingForApproval
    );
}

#[test]
fn filesystem_resource_routes_are_independent_of_selection_and_never_grant_access() {
    let first = TestDir::new("route-first", "original.txt");
    let second = TestDir::new("route-second", "original.txt");
    let read_only = TestDir::new("route-read-only", "original.txt");
    let outside = TestDir::new("route-outside", "original.txt");
    let server = server();
    let start = |name: &str| {
        server
            .threads
            .start_thread(
                &ash_core::NoThreadWorktreeBinder,
                StartThreadRequest {
                    command_id: CommandId::new(name).unwrap(),
                    title: name.into(),
                    execution_target: None,
                    branch_name: None,
                    agent_id: None,
                    agent: None,
                },
            )
            .unwrap()
    };
    let a = start("route-a");
    let b = start("route-b");
    let mut connection = server.product_host_connection();
    let request_id = AtomicUsize::new(1);
    let rpc = |connection: &mut ConnectionState,
               method: &str,
               params: serde_json::Value|
     -> serde_json::Value {
        serde_json::from_str(
            &server.handle_json(
                connection,
                &serde_json::json!({
                    "jsonrpc":"2.0", "id":request_id.fetch_add(1, Ordering::SeqCst), "method":method, "params":params,
                })
                .to_string(),
            ),
        )
        .unwrap()
    };
    let initialized = rpc(
        &mut connection,
        "initialize",
        serde_json::json!({"clientInfo":{"name":"resource-route-test","version":"1"}}),
    );
    assert!(initialized.get("error").is_none(), "{initialized}");
    let access = server.env_runtime.read().unwrap().dir_grants.clone();
    access.bind_thread_dir(a.thread_id.clone(), first.root());
    access.bind_thread_dir(b.thread_id.clone(), second.root());
    access
        .add_dir(
            a.session_id.clone(),
            Grant::for_session_tree(
                a.session_id.clone(),
                read_only.root(),
                GrantSource::ExplicitUser,
                Permissions::new([Permission::BrowseFiles, Permission::ReadFiles]),
            ),
        )
        .unwrap();
    let resolve = |connection: &mut ConnectionState, path: &Path| {
        rpc(
            connection,
            "fs/resolvePath",
            serde_json::json!({"path":path}),
        )
    };
    let a_route = resolve(&mut connection, &first.path.join("missing/child.txt"));
    assert!(a_route.get("error").is_none(), "{a_route}");
    assert_eq!(a_route["result"]["root"], serde_json::json!(first.path));
    assert_eq!(
        a_route["result"]["target"],
        serde_json::json!({"type":"session","sessionDirectory":{"sessionId":a.session_id,"path":first.path}})
    );
    let b_route = resolve(&mut connection, &second.path.join("original.txt"));
    assert_eq!(
        b_route["result"]["target"]["sessionDirectory"]["sessionId"],
        serde_json::json!(b.session_id)
    );
    // Resolve B first, then write through A's retained selector. No active Workspace is involved.
    let written = rpc(
        &mut connection,
        "fs/writeFile",
        serde_json::json!({
            "sessionDirectory":a_route["result"]["target"]["sessionDirectory"], "path":"created.txt",
            "content":"retained editor\n", "options":{"mode":"create"},
        }),
    );
    assert!(written.get("error").is_none(), "{written}");
    assert_eq!(
        std::fs::read_to_string(first.path.join("created.txt")).unwrap(),
        "retained editor\n"
    );
    assert!(!second.path.join("created.txt").exists());
    let read_route = resolve(&mut connection, &read_only.path.join("original.txt"));
    assert!(read_route.get("error").is_none(), "{read_route}");
    let denied = rpc(
        &mut connection,
        "fs/writeFile",
        serde_json::json!({
            "sessionDirectory":read_route["result"]["target"]["sessionDirectory"], "path":"forbidden.txt",
            "content":"no", "options":{"mode":"create"},
        }),
    );
    assert!(
        denied.get("error").is_some(),
        "Discovery must not confer write permission: {denied}"
    );
    assert!(!read_only.path.join("forbidden.txt").exists());
    assert!(
        resolve(&mut connection, &outside.path.join("original.txt"))
            .get("error")
            .is_some()
    );
    assert!(
        resolve(&mut connection, Path::new("relative/file"))
            .get("error")
            .is_some()
    );
    assert!(
        resolve(&mut connection, &first.path.join("../escape"))
            .get("error")
            .is_some()
    );
    access.unbind_thread_dir(&a.thread_id);
    assert!(
        resolve(&mut connection, &first.path.join("original.txt"))
            .get("error")
            .is_some()
    );
    let revoked = rpc(
        &mut connection,
        "fs/writeFile",
        serde_json::json!({
            "sessionDirectory":a_route["result"]["target"]["sessionDirectory"], "path":"after-revoke.txt",
            "content":"no", "options":{"mode":"create"},
        }),
    );
    assert!(
        revoked.get("error").is_some(),
        "A retained route must reauthorize: {revoked}"
    );
    assert!(!first.path.join("after-revoke.txt").exists());
}
