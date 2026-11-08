use crate::AppServer;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[test]
fn project_memory_from_message_keeps_verified_source_and_user_ownership() {
    use ash_protocol::CommandId;
    use ash_protocol::ProjectId;
    use ash_protocol::ThreadItem;

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
        ash_app_server_diff::compute,
    )
    .with_ephemeral_env_state()
    .with_local_projects(&path)
    .unwrap()
    .with_local_memories(&path)
    .unwrap();
    let mut host = server.product_host_connection();
    let mut request_id = 0;
    let mut call = |method: &str, params: Value| {
        request_id += 1;
        crate::tests::call(
            &server,
            &mut host,
            json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}),
        )
    };
    assert!(
        call(
            "initialize",
            json!({"clientInfo":{"name":"test","version":"1"}})
        )
        .get("result")
        .is_some()
    );
    let created = call(
        "session/create",
        json!({
            "commandId":"create-session", "kind":"code", "title":"Project work", "executionTarget":null,
        }),
    );
    assert!(created.get("result").is_some(), "{created}");
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let created = call(
        "session/request",
        json!({
            "commandId":"create-thread", "sessionId":session_id, "request":{"type":"createThread","title":"root"},
        }),
    );
    let thread_id = created["result"]["value"]["threadId"].as_str().unwrap();
    let thread = ash_protocol::ThreadId::new(thread_id).unwrap();
    let sequence = server.threads().read_thread(&thread).unwrap().sequence;
    let started = call(
        "session/request",
        json!({
            "commandId":"start-turn", "sessionId":session_id, "request":{
            "type":"startTurn", "threadId":thread_id, "expectedSequence":sequence, "mode":"agent",
                "input":[{"type":"text","text":"The demo uses the violet sample."}],
            },
        }),
    );
    assert!(started.get("result").is_some(), "{started}");
    let snapshot = server.threads().read_thread(&thread).unwrap();
    let (turn, item) = snapshot
        .items
        .iter()
        .find_map(|item| match item {
            ThreadItem::UserMessage {
                item_id, turn_id, ..
            } => Some((turn_id, item_id)),
            _ => None,
        })
        .unwrap();
    let project = ProjectId::new("demo").unwrap();
    let coordinator = server.projects.as_ref().unwrap();
    for (command_id, expected_revision, command) in [
        (
            "create-project",
            0,
            ash_projects::ProjectCommand::Create {
                scope: Some(ash_projects::ProjectScope::Code),
                name: "Demo".into(),
                description: String::new(),
                materials: Vec::new(),
            },
        ),
        (
            "link-session",
            1,
            ash_projects::ProjectCommand::LinkSession {
                session_id: snapshot.session_id.clone(),
            },
        ),
    ] {
        coordinator
            .apply(ash_projects::ProjectCommandRequest {
                command_id: CommandId::new(command_id).unwrap(),
                project_id: project.clone(),
                expected_revision,
                command,
            })
            .unwrap();
    }

    let origin = json!({"sessionId":session_id,"threadId":thread_id,"turnId":turn,"itemId":item});
    let scope = json!({"type":"project","projectId":"demo"});
    let add = json!({
        "commandId":"remember", "memoryId":"demo-note", "scope":scope,
        "title":"Demo sample", "body":"The demo uses the violet sample.", "origin":origin,
    });
    let mut forged = add.clone();
    forged["origin"]["itemId"] = json!("nonexistent-item");
    assert_eq!(
        call("memory/add", forged)["error"]["message"],
        "InvalidParams"
    );
    let saved = call("memory/add", add.clone());
    assert_eq!(
        saved["result"]["memory"]["source"]["userFromTurn"], origin,
        "{saved}"
    );
    assert_eq!(call("memory/add", add)["result"]["disposition"], "replayed");
    let edited = call(
        "memory/update",
        json!({
            "commandId":"edit", "memoryId":"demo-note", "scope":scope,
            "expectedRevision":1, "title":"Demo sample", "body":"Use the violet sample for demos.",
        }),
    );
    assert_eq!(
        edited["result"]["memory"]["source"]["userFromTurn"], origin,
        "{edited}"
    );
}

#[test]
fn memory_requests_forward_cancellation_and_only_notify_committed_writes() {
    for revision in [0, 1] {
        let root = tempfile::tempdir().unwrap();
        let server = AppServer::new(
            Arc::new(ThreadController::with_store(Arc::new(
                InMemoryThreadStore::default(),
            ))),
            Arc::new(crate::local::ProviderModelService::new(Arc::new(EchoModel))),
            ash_app_server_diff::compute,
        )
        .with_ephemeral_env_state()
        .with_local_memories(&root.path().join("state.sqlite"))
        .unwrap();
        let mut host = server.product_host_connection();
        server
            .initialize(
                &mut host,
                &json!({"clientInfo":{"name":"test","version":"1"},"capabilities":{}}),
            )
            .unwrap();
        let notifications = server.connection_notifications(&host);
        // Enter the real dispatcher directly: handle_json's initial cancellation check must not
        // mask a missing token in the Memory handler or domain call.
        let mut dispatch = |method: &str, params: Value, cancellation: &CancellationToken| {
            let mut request = serde_json::from_value(
                json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}),
            )
            .unwrap();
            server.dispatch(&mut host, &mut request, cancellation)
        };
        let active = CancellationSource::new();
        let seed = json!({"commandId":"seed","memoryId":"decision","scope":{"type":"profile"},"title":"Decision","body":"Original fact"});
        if revision == 1 {
            dispatch("memory/add", seed.clone(), &active.token()).unwrap();
            assert_eq!(notifications.drain().len(), 1);
        }
        let service = server.memories.as_ref().unwrap();
        let snapshot = || {
            service
                .list(memories::ListMemoriesRequest {
                    scope: memories::MemoryScope::Profile,
                    cursor: None,
                    limit: 10,
                })
                .unwrap()
        };
        let before = snapshot();
        let (method, params) = if revision == 0 {
            ("memory/add", seed)
        } else {
            (
                "memory/update",
                json!({"commandId":"update","memoryId":"decision","scope":{"type":"profile"},"expectedRevision":1,"title":"Decision","body":"Updated fact"}),
            )
        };
        let cancelled = CancellationSource::new();
        cancelled.cancel();
        let error = dispatch(method, params.clone(), &cancelled.token()).unwrap_err();
        assert_eq!(error.code, -32800);
        assert_eq!(error.message, super::AppServerErrorName::RequestCancelled);
        assert_eq!(snapshot(), before);
        assert!(notifications.drain().is_empty());
        if revision == 1 {
            assert_eq!(
                service
                    .read(memories::ReadMemoryRequest {
                        scope: memories::MemoryScope::Profile,
                        memory_id: memories::MemoryId::new("decision").unwrap(),
                    })
                    .unwrap()
                    .body,
                "Original fact"
            );
        }
        let saved = dispatch(method, params.clone(), &active.token()).unwrap();
        assert_eq!(saved["disposition"], "committed");
        assert_eq!(saved["memory"]["revision"], revision + 1);
        assert_eq!(notifications.drain().len(), 1);
        let replay = dispatch(method, params, &active.token()).unwrap();
        assert_eq!(replay["disposition"], "replayed");
        assert!(notifications.drain().is_empty());
    }
}
