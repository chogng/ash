use super::ArtifactCatalogRequestProcessor;
use super::ConnectionAuthority;
use super::artifact_catalog_error;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::fs::FsDirectoryTarget;
use ash_artifact_catalog::ArtifactCatalogError;
use ash_artifact_catalog::NATIVE_ARTIFACT_CLIENT;
use ash_artifact_catalog::SqliteArtifactCatalog;
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
use ash_protocol::ThreadItem;
use ash_protocol::TurnInstructions;
use ash_protocol::UserInput;
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
fn artifact_catalog_processor_enforces_product_host_and_unavailable_errors() {
    let directory = tempfile::tempdir().unwrap();
    let configured = ArtifactCatalogRequestProcessor::new(
        Arc::new(SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap()),
        None,
    );
    let unavailable = ArtifactCatalogRequestProcessor::default();
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
                    .list(authority, &json!({"clientId":"ui"}))
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
            .list(ConnectionAuthority::ProductHost, &json!({"clientId":"ui"}))
            .unwrap_err(),
    ] {
        assert_eq!(error.code, -32002);
        assert_eq!(
            error.message,
            AppServerErrorName::ArtifactCatalogUnavailable
        );
    }
}

#[test]
fn artifact_catalog_notifications_require_initialized_local_product_hosts() {
    let directory = tempfile::tempdir().unwrap();
    let server = crate::tests::server()
        .with_artifact_catalog(
            Arc::new(SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap()),
            directory.path().join("documents"),
            None,
        )
        .unwrap();
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
            "jsonrpc":"2.0", "id":2, "method":"artifactCatalog/register", "params":registration()
        }),
    );
    assert!(response.get("result").is_some(), "{response}");
    let notifications = server
        .drain_notifications(&mut writer)
        .into_iter()
        .map(|value| serde_json::from_str::<Value>(&value).unwrap())
        .filter(|value| value["method"] == "artifactCatalog/changed")
        .collect::<Vec<_>>();
    assert_eq!(
        notifications,
        vec![
            json!({"jsonrpc":"2.0", "method":"artifactCatalog/changed", "params":{"clientId":"ui"}})
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
fn artifact_catalog_processor_preserves_metadata_and_structured_errors() {
    let directory = tempfile::tempdir().unwrap();
    let processor = ArtifactCatalogRequestProcessor::new(
        Arc::new(SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap()),
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
    assert_eq!(
        conflict.message,
        AppServerErrorName::ArtifactCatalogConflict
    );
    request["file"]["id"] = json!("invalid");
    let invalid = processor
        .register(ConnectionAuthority::ProductHost, &request, &updates)
        .unwrap_err();
    assert_eq!(invalid.code, -32602);
    assert_eq!(invalid.message, AppServerErrorName::ArtifactCatalogInvalid);
    assert_eq!(
        processor
            .list(ConnectionAuthority::ProductHost, &json!({"clientId":"ui"}))
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
    let failure =
        artifact_catalog_error(ArtifactCatalogError::Storage("database unavailable".into()));
    assert_eq!(failure.code, -32000);
    assert_eq!(
        failure.message,
        AppServerErrorName::ArtifactCatalogOperationFailed
    );
}

#[test]
fn artifact_catalog_browser_only_sees_native_and_desktop_filters_imports_by_account() {
    let directory = tempfile::tempdir().unwrap();
    let store =
        Arc::new(SqliteArtifactCatalog::open(&directory.path().join("state.sqlite")).unwrap());
    let processor = ArtifactCatalogRequestProcessor::new(
        store.clone(),
        Some(Arc::new(ash_documents::Documents::new(
            store,
            directory.path().join("documents"),
        ))),
    );
    let updates = super::UpdateBroker::default();
    let mut request = registration();
    request["file"]["source"]["accountId"] = json!("first-account");
    let registered = processor
        .register(ConnectionAuthority::ProductHost, &request, &updates)
        .unwrap();

    let list = |authority, account| {
        processor
            .list(authority, &json!({"clientId":"ui", "accountIds":[account]}))
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
fn artifact_catalog_recover_one_document_at_a_time_and_route_only_published_files() {
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("state.sqlite");
    let directory = profile.path().canonicalize().unwrap().join("documents");
    let store = Arc::new(SqliteArtifactCatalog::open(&database).unwrap());
    stage_turns(&database, Some("ash.creation.docs"));
    let history = Arc::new(SqliteThreadStore::open(&database).unwrap());
    let pending = history.pending_turn_completions(0).unwrap();
    let ids: Vec<_> = pending
        .iter()
        .map(|completion| {
            let item_id = completion
                .turn
                .items
                .iter()
                .rev()
                .find_map(|item| match item {
                    ThreadItem::AgentMessage { item_id, .. } => Some(item_id),
                    _ => None,
                })
                .unwrap();
            ash_protocol::ContentDigest::sha256(
                serde_json::json!([
                    "local-agent-host",
                    null,
                    completion.session_id.as_str(),
                    completion.thread_id.as_str(),
                    item_id.as_str(),
                    "markdown"
                ])
                .to_string()
                .as_bytes(),
            )
            .as_str()
            .trim_start_matches("sha256:")
            .to_owned()
        })
        .collect();
    assert_eq!(ids.len(), 2);
    let published = format!("{}.md", ids[0]);
    let blocked = format!("{}.md", ids[1]);

    // The first startup cannot publish anything. Keep the receipts for the next attempt.
    std::fs::write(&directory, "not a directory").unwrap();
    let server = crate::tests::server()
        .with_artifact_catalog(store.clone(), directory.clone(), Some(history.clone()))
        .unwrap();
    assert!(store.list(NATIVE_ARTIFACT_CLIENT, &[]).unwrap().is_empty());
    assert_eq!(history.pending_turn_completions(0).unwrap().len(), 2);
    let processor = &server.documents_processor;
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
        .filter(|notification| notification["method"] == "artifactCatalog/changed")
        .collect::<Vec<_>>();
    assert_eq!(notifications.len(), 1);
    assert_eq!(
        notifications[0]["params"]["clientId"],
        NATIVE_ARTIFACT_CLIENT
    );
    assert_eq!(
        history
            .pending_turn_completions(0)
            .unwrap()
            .iter()
            .map(|completion| completion.id)
            .collect::<Vec<_>>(),
        [pending[1].id]
    );

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
            .web_file_system(Some(&format!(
                "{}{}",
                crate::server::documents_processor::WEB_FILE_ROUTE,
                ids[1]
            )))
            .is_err()
    );
    let files = processor.web_file_system(Some(&dir_id)).unwrap().unwrap();
    assert_eq!(
        files.read_file(Path::new(&published), 100).unwrap(),
        b"# User edit"
    );
    assert!(files.read_file(Path::new(&blocked), 100).is_err());

    let markdown = pending[1]
        .turn
        .items
        .iter()
        .rev()
        .find_map(|item| match item {
            ThreadItem::AgentMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    std::fs::remove_dir(directory.join(&blocked)).unwrap();
    processor.publish_native(&server.updates);
    assert_eq!(
        std::fs::read_to_string(directory.join(&blocked)).unwrap(),
        markdown
    );
    assert!(history.pending_turn_completions(0).unwrap().is_empty());
    assert_eq!(store.list(NATIVE_ARTIFACT_CLIENT, &[]).unwrap().len(), 2);
}

#[test]
fn document_publication_recovers_after_its_source_session_is_deleted() {
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("state.sqlite");
    let store = Arc::new(SqliteArtifactCatalog::open(&database).unwrap());
    let threads = stage_turns(&database, Some("ash.creation.docs"));
    threads
        .delete_session_threads(&SessionId::new("docs").unwrap())
        .unwrap();
    let history = Arc::new(SqliteThreadStore::open(&database).unwrap());
    assert_eq!(history.pending_turn_completions(0).unwrap().len(), 2);
    let directory = profile.path().canonicalize().unwrap().join("documents");
    let server = crate::tests::server()
        .with_artifact_catalog(store.clone(), directory.clone(), Some(history.clone()))
        .unwrap();
    assert!(history.pending_turn_completions(0).unwrap().is_empty());
    let published = store.list(NATIVE_ARTIFACT_CLIENT, &[]).unwrap();
    assert_eq!(published.len(), 2);
    for file in published {
        assert!(directory.join(format!("{}.md", file.file.id)).is_file());
    }
    drop(server);
}

#[test]
fn ordinary_completions_are_acknowledged_without_accessing_the_document_directory() {
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("state.sqlite");
    let store = Arc::new(SqliteArtifactCatalog::open(&database).unwrap());
    stage_turns(&database, None);
    let history = Arc::new(SqliteThreadStore::open(&database).unwrap());
    assert_eq!(history.pending_turn_completions(0).unwrap().len(), 2);
    let directory = profile.path().canonicalize().unwrap().join("documents");
    std::fs::write(&directory, "not a directory").unwrap();
    let server = crate::tests::server()
        .with_artifact_catalog(store.clone(), directory.clone(), Some(history.clone()))
        .unwrap();
    assert!(history.pending_turn_completions(0).unwrap().is_empty());
    assert!(store.list(NATIVE_ARTIFACT_CLIENT, &[]).unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(directory).unwrap(),
        "not a directory"
    );
    drop(server);
}

#[test]
fn reading_the_artifact_catalog_does_not_create_pending_documents() {
    let profile = tempfile::tempdir().unwrap();
    let database = profile.path().join("state.sqlite");
    let store = Arc::new(SqliteArtifactCatalog::open(&database).unwrap());
    let history = Arc::new(SqliteThreadStore::open(&database).unwrap());
    let directory = profile.path().canonicalize().unwrap().join("documents");
    let server = crate::tests::server()
        .with_artifact_catalog(store, directory.clone(), Some(history.clone()))
        .unwrap();
    stage_turns(&database, Some("ash.creation.docs"));
    let listed = server
        .artifact_catalog_processor
        .list(ConnectionAuthority::ProductHost, &json!({"clientId":"ui"}))
        .unwrap();
    assert_eq!(listed["files"], json!([]));
    assert_eq!(history.pending_turn_completions(0).unwrap().len(), 2);
    assert!(!directory.exists());
    server.documents_processor.publish_native(&server.updates);
    assert!(history.pending_turn_completions(0).unwrap().is_empty());
    assert!(directory.is_dir());
}

fn stage_turns(database: &Path, context: Option<&str>) -> ThreadController {
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
        let mut input = vec![UserInput::Text {
            text: "Write a document".into(),
        }];
        if let Some(name) = context {
            input.push(UserInput::Context {
                name: name.into(),
                content: "Write Markdown".into(),
                source_url: None,
            });
        }
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
                    input,
                },
            )
            .unwrap();
        threads
            .complete_turn(&thread, &turn.turn_id, format!("# {title}"))
            .unwrap();
    }
    threads
}
