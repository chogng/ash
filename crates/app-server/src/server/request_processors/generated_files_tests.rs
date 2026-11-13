use super::ConnectionAuthority;
use super::GeneratedFileRequestProcessor;
use super::generated_file_error;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::fs::FsDirectoryTarget;
use ash_core::CreateThreadRequest;
use ash_core::StartTurnRequest;
use ash_core::ThreadController;
use ash_protocol::AgentId;
use ash_protocol::CommandId;
use ash_protocol::ModelId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::TurnInstructions;
use ash_protocol::UserInput;
use ash_state::GeneratedFileError;
use ash_state::NATIVE_GENERATED_FILE_CLIENT;
use ash_state::SqliteGeneratedFileStore;
use ash_state::SqliteThreadStore;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

fn registration() -> Value {
    json!({"clientId":"ui", "file":{
        "id":"a".repeat(64), "resource":"ash-profile:/generated/review.md",
        "title":"评审", "contentType":"text/markdown",
        "source":{"providerId":"provider", "accountId":null, "sessionId":"session",
            "threadId":"thread", "itemId":"item", "partId":"part"}
    }})
}

#[test]
fn generated_file_processor_enforces_product_host_and_unavailable_errors() {
    let directory = tempfile::tempdir().unwrap();
    let configured = GeneratedFileRequestProcessor::new(
        Arc::new(SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap()),
        None,
    );
    let unavailable = GeneratedFileRequestProcessor::default();
    let updates = super::UpdateBroker::default();
    for processor in [&configured, &unavailable] {
        for authority in [
            ConnectionAuthority::Client,
            ConnectionAuthority::Browser,
            ConnectionAuthority::RemoteHost,
        ] {
            for error in [
                processor
                    .register(authority, &registration(), &updates)
                    .unwrap_err(),
                processor
                    .list(authority, &json!({"clientId":"ui"}), &updates)
                    .unwrap_err(),
            ] {
                assert_eq!(error.code, -32001);
                assert_eq!(error.message, AppServerErrorName::PermissionRequired);
            }
        }
    }
    for error in [
        unavailable
            .register(ConnectionAuthority::ProductHost, &registration(), &updates)
            .unwrap_err(),
        unavailable
            .list(
                ConnectionAuthority::ProductHost,
                &json!({"clientId":"ui"}),
                &updates,
            )
            .unwrap_err(),
    ] {
        assert_eq!(error.code, -32002);
        assert_eq!(error.message, AppServerErrorName::GeneratedFileUnavailable);
    }
}

#[test]
fn generated_file_notifications_require_initialized_local_product_hosts() {
    let directory = tempfile::tempdir().unwrap();
    let server = crate::tests::server().with_generated_file_store(
        Arc::new(SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap()),
        directory.path().join("generated-files"),
    );
    let mut writer = server.product_host_connection();
    crate::tests::initialize(&server, &mut writer);
    let mut denied = [
        server.open_connection(ConnectionAuthority::Client),
        server.open_connection(ConnectionAuthority::Browser),
        server.open_connection(ConnectionAuthority::RemoteHost),
    ];
    for connection in &mut denied {
        crate::tests::initialize(&server, connection);
        server.drain_notifications(connection);
    }
    let mut pending = server.product_host_connection();
    let response = crate::tests::call(
        &server,
        &mut writer,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"generatedFile/register", "params":registration()
        }),
    );
    assert!(response.get("result").is_some(), "{response}");
    let notifications = server
        .drain_notifications(&mut writer)
        .into_iter()
        .map(|value| serde_json::from_str::<Value>(&value).unwrap())
        .filter(|value| value["method"] == "generatedFile/changed")
        .collect::<Vec<_>>();
    assert_eq!(
        notifications,
        vec![
            json!({"jsonrpc":"2.0", "method":"generatedFile/changed", "params":{"clientId":"ui"}})
        ]
    );
    for connection in &mut denied {
        assert!(server.drain_notifications(connection).is_empty());
    }
    assert!(server.drain_notifications(&mut pending).is_empty());
    for connection in denied {
        server.close_connection(connection);
    }
    server.close_connection(pending);
    server.close_connection(writer);
}

#[test]
fn generated_file_processor_preserves_metadata_and_structured_errors() {
    let directory = tempfile::tempdir().unwrap();
    let processor = GeneratedFileRequestProcessor::new(
        Arc::new(SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap()),
        None,
    );
    let updates = super::UpdateBroker::default();
    let mut request = registration();
    let original = processor
        .register(ConnectionAuthority::ProductHost, &request, &updates)
        .unwrap();
    assert!(original["file"]["source"]["accountId"].is_null());
    assert!(original["file"]["createdAt"].as_i64().unwrap() > 0);
    request["file"]["title"] = json!("retry metadata");
    assert_eq!(
        processor
            .register(ConnectionAuthority::ProductHost, &request, &updates)
            .unwrap(),
        original
    );
    request["file"]["resource"] = json!("file:///other.md");
    let conflict = processor
        .register(ConnectionAuthority::ProductHost, &request, &updates)
        .unwrap_err();
    assert_eq!(conflict.code, -32003);
    assert_eq!(conflict.message, AppServerErrorName::GeneratedFileConflict);
    request["file"]["id"] = json!("invalid");
    let invalid = processor
        .register(ConnectionAuthority::ProductHost, &request, &updates)
        .unwrap_err();
    assert_eq!(invalid.code, -32602);
    assert_eq!(invalid.message, AppServerErrorName::GeneratedFileInvalid);
    assert_eq!(
        processor
            .list(
                ConnectionAuthority::ProductHost,
                &json!({"clientId":"ui"}),
                &updates
            )
            .unwrap()["files"],
        json!([original["file"]])
    );
    request = registration();
    request["file"]["content"] = json!("must not accept a body");
    assert_eq!(
        processor
            .register(ConnectionAuthority::ProductHost, &request, &updates)
            .unwrap_err()
            .message,
        AppServerErrorName::InvalidParams
    );
    let failure = generated_file_error(GeneratedFileError::Storage("database unavailable".into()));
    assert_eq!(failure.code, -32000);
    assert_eq!(
        failure.message,
        AppServerErrorName::GeneratedFileOperationFailed
    );
}

#[test]
fn generated_files_browser_only_sees_native_and_desktop_filters_imports_by_account() {
    let directory = tempfile::tempdir().unwrap();
    let processor = GeneratedFileRequestProcessor::new(
        Arc::new(SqliteGeneratedFileStore::open(&directory.path().join("state.sqlite")).unwrap()),
        Some(directory.path().join("generated-files")),
    );
    let updates = super::UpdateBroker::default();
    let mut request = registration();
    request["file"]["source"]["accountId"] = json!("first-account");
    let registered = processor
        .register(ConnectionAuthority::ProductHost, &request, &updates)
        .unwrap();

    let list = |authority, account| {
        processor
            .list(
                authority,
                &json!({"clientId":"ui", "accountIds":[account]}),
                &updates,
            )
            .unwrap()["files"]
            .clone()
    };
    assert_eq!(
        list(ConnectionAuthority::ProductHost, "first-account"),
        json!([registered["file"]])
    );
    assert_eq!(
        list(ConnectionAuthority::ProductHost, "second-account"),
        json!([])
    );
    assert_eq!(
        list(ConnectionAuthority::Browser, "first-account"),
        json!([])
    );
    assert_eq!(
        processor
            .register(ConnectionAuthority::Browser, &request, &updates)
            .unwrap_err()
            .message,
        AppServerErrorName::PermissionRequired
    );
}

#[test]
fn generated_files_recover_one_document_at_a_time_and_route_only_published_files() {
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("state.sqlite");
    let directory = profile
        .path()
        .canonicalize()
        .unwrap()
        .join("generated-files");
    let store = Arc::new(SqliteGeneratedFileStore::open(&database).unwrap());
    stage_docs_turns(&database);
    let ids = store.pending_native_ids().unwrap();
    assert_eq!(ids.len(), 2);
    let published = super::native_file_name(&ids[0]);
    let blocked = super::native_file_name(&ids[1]);

    // The first startup cannot publish anything. Keep the receipts for the next attempt.
    std::fs::write(&directory, "not a directory").unwrap();
    let server = crate::tests::server().with_generated_file_store(store.clone(), directory.clone());
    assert!(
        store
            .list(NATIVE_GENERATED_FILE_CLIENT, &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.pending_native_ids().unwrap(), ids);
    let processor = &server.generated_files_processor;
    let mut observer = server.product_host_connection();
    crate::tests::initialize(&server, &mut observer);
    server.drain_notifications(&mut observer);

    // The first file was edited after an interrupted publication; the second is blocked.
    std::fs::remove_file(&directory).unwrap();
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join(&published), "# User edit").unwrap();
    std::fs::create_dir(directory.join(&blocked)).unwrap();
    processor.publish_native(&server.updates);
    let notifications = server
        .drain_notifications(&mut observer)
        .into_iter()
        .map(|notification| serde_json::from_str::<Value>(&notification).unwrap())
        .filter(|notification| notification["method"] == "generatedFile/changed")
        .collect::<Vec<_>>();
    assert_eq!(notifications.len(), 1);
    assert_eq!(
        notifications[0]["params"]["clientId"],
        NATIVE_GENERATED_FILE_CLIENT
    );
    assert_eq!(store.pending_native_ids().unwrap(), [ids[1].clone()]);

    let route = processor
        .web_file_route(&directory.join(&published))
        .unwrap();
    let FsDirectoryTarget::Environment { dir_id } = route.target else {
        panic!("expected an exact environment file route");
    };
    assert_eq!(route.exact_file, Some(true));
    assert!(
        processor
            .web_file_route(&directory.join(&blocked))
            .is_none()
    );
    assert!(
        processor
            .web_file_system(Some(&format!("{}{}", super::WEB_FILE_ROUTE, ids[1])))
            .is_err()
    );
    let files = processor.web_file_system(Some(&dir_id)).unwrap().unwrap();
    assert_eq!(
        files.read_file(Path::new(&published), 100).unwrap(),
        b"# User edit"
    );
    assert!(files.read_file(Path::new(&blocked), 100).is_err());

    let markdown = store.pending_native_markdown(&ids[1]).unwrap().unwrap();
    std::fs::remove_dir(directory.join(&blocked)).unwrap();
    processor.publish_native(&server.updates);
    assert_eq!(
        std::fs::read_to_string(directory.join(&blocked)).unwrap(),
        markdown
    );
    assert!(store.pending_native_ids().unwrap().is_empty());
    assert_eq!(
        store.list(NATIVE_GENERATED_FILE_CLIENT, &[]).unwrap().len(),
        2
    );
}

fn stage_docs_turns(database: &Path) {
    let threads =
        ThreadController::with_store(Arc::new(SqliteThreadStore::open(database).unwrap()));
    let thread = ThreadId::new("docs").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            agent_id: AgentId::new("docs-agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new(thread.as_str()).unwrap(),
            thread_id: thread.clone(),
            title: "Source conversation".into(),
            execution_target: None,
        })
        .unwrap();
    for title in ["First", "Second"] {
        let turn = threads
            .start_turn(
                &thread,
                StartTurnRequest {
                    context_policy: Default::default(),
                    command_id: CommandId::new(title).unwrap(),
                    expected_sequence: core_api::SequenceExpectation::Any,
                    model: Some(ModelRef::new(
                        ProviderId::new("test").unwrap(),
                        ModelId::new("test").unwrap(),
                    )),
                    reasoning_effort: None,
                    advisor: None,
                    kind: Default::default(),
                    mode: Default::default(),
                    instructions: TurnInstructions::new("test", "docs", "1", "Write a document")
                        .unwrap(),
                    policy_revision: "test".into(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![
                        UserInput::Text {
                            text: "Write a document".into(),
                        },
                        UserInput::Context {
                            name: "ash.creation.docs".into(),
                            content: "Write Markdown".into(),
                            source_url: None,
                        },
                    ],
                },
            )
            .unwrap();
        threads
            .complete_turn(&thread, &turn.turn_id, format!("# {title}"))
            .unwrap();
    }
}
