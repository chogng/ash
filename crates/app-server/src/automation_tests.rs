use super::call;
use super::initialize;
use super::server;
use ash_automation::AutomationStore;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use ash_protocol::AutomationSession;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

fn create_run(
    store: &AutomationStore,
    directory: &std::path::Path,
    session: AutomationSession,
) -> AutomationRun {
    let now = ash_automation::now().unwrap();
    let request: ash_automation::AutomationWrite = serde_json::from_value(json!({
        "command_id":"create", "id":"test", "expected_revision":0, "status":"paused",
        "definition":{"title":"Test", "prompt":"Say hello", "directory":directory,
            "session":session, "schedule":{"type":"interval", "anchor":0, "minutes":60}}
    }))
    .unwrap();
    store.write(&request, now).unwrap();
    store.run_now("test", "manual", now).unwrap()
}

#[test]
fn automation_session_deletion_stops_runs_even_before_first_observation() {
    for recorded in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
        let server =
            super::server_with_model(Arc::new(super::AppServerInteractiveModel::default()))
                .with_tool_service(
                    Arc::new(super::AppServerInteractiveTool),
                    Arc::new(super::ShellTestPolicy),
                )
                .with_automation_store(Arc::clone(&store));
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        let mut observed = create_run(&store, dir.path(), AutomationSession::New);
        let deadline = Instant::now() + Duration::from_secs(5);
        while observed.status != AutomationRunStatus::NeedsInput && Instant::now() < deadline {
            observed = server
                .advance_automation_run(&observed, ash_automation::now().unwrap())
                .unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            observed.status,
            AutomationRunStatus::NeedsInput,
            "{observed:?}"
        );
        if recorded {
            store.observe(&observed).unwrap();
        }
        let deleted = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":2, "method":"session/request", "params":{
                "commandId":"delete", "sessionId":observed.session_id,
                "request":{"type":"delete"}
            }}),
        );
        assert_eq!(deleted["result"]["type"], "deleted", "{deleted}");
        assert!(store.active_runs().unwrap().is_empty());
        let stopped = store.runs("test", 50).unwrap().remove(0);
        assert_eq!(stopped.status, AutomationRunStatus::Stopped);
        assert!(stopped.finished_at.is_some());
        // A scheduler observation taken before deletion cannot revive the terminal run.
        store.observe(&observed).unwrap();
        assert!(store.active_runs().unwrap().is_empty());
        assert_eq!(store.stop_run(&stopped.id).unwrap(), stopped);
        let next = store
            .run_now("test", "next", ash_automation::now().unwrap())
            .unwrap();
        let stopping = store.stop_run(&next.id).unwrap();
        let stopped = server
            .advance_automation_run(&stopping, ash_automation::now().unwrap())
            .unwrap();
        store.observe(&stopped).unwrap();
        let deleted = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0", "id":3, "method":"automation/delete",
                "params":{"id":"test", "expectedRevision":1}}),
        );
        assert!(deleted.get("error").is_none(), "{deleted}");
    }
}

#[test]
fn automation_session_deletion_stops_pending_continuations() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = super::create_session(&server, &mut connection, 2, "target");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let run = create_run(
        &store,
        dir.path(),
        AutomationSession::Continue {
            session_id: ash_protocol::SessionId::new(session_id).unwrap(),
            thread_id: ash_protocol::ThreadId::new(session_id).unwrap(),
        },
    );
    let now = ash_automation::now().unwrap();
    let mut unrelated_definition = run.definition.clone();
    unrelated_definition.session = AutomationSession::New;
    store
        .write(
            &ash_automation::AutomationWrite {
                command_id: "create-unrelated".into(),
                id: "unrelated".into(),
                expected_revision: 0,
                definition: unrelated_definition,
                status: ash_protocol::AutomationStatus::Paused,
            },
            now,
        )
        .unwrap();
    let unrelated = store.run_now("unrelated", "unrelated", now).unwrap();
    server.drain_notifications(&mut connection);
    let deleted = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":3, "method":"session/request", "params":{
            "commandId":"delete", "sessionId":session_id, "request":{"type":"delete"}
        }}),
    );
    assert_eq!(deleted["result"]["type"], "deleted", "{deleted}");
    assert_eq!(store.active_runs().unwrap(), vec![unrelated]);
    assert!(
        server
            .drain_notifications(&mut connection)
            .iter()
            .any(|notification| notification.contains("\"method\":\"automation/changed\""))
    );
    assert_eq!(
        store.stop_run(&run.id).unwrap().status,
        AutomationRunStatus::Stopped
    );
}

#[test]
fn automation_missing_target_is_terminal_including_after_a_stop_request() {
    for stopping in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = AutomationStore::open(&dir.path().join("state.db")).unwrap();
        let server = server();
        let mut run = create_run(
            &store,
            dir.path(),
            AutomationSession::Continue {
                session_id: ash_protocol::SessionId::new("deleted").unwrap(),
                thread_id: ash_protocol::ThreadId::new("deleted").unwrap(),
            },
        );
        // Also exercise a run whose target was already observed before it disappeared.
        if stopping {
            run.session_id = Some(ash_protocol::SessionId::new("deleted").unwrap());
            run.thread_id = Some(ash_protocol::ThreadId::new("deleted").unwrap());
            store.observe(&run).unwrap();
            run = store.stop_run(&run.id).unwrap();
        }
        let now = ash_automation::now().unwrap();
        let observed = server.advance_automation_run(&run, now).unwrap();
        assert_eq!(observed.status, AutomationRunStatus::Stopped);
        assert_eq!(observed.finished_at, Some(now));
        store.observe(&observed).unwrap();
        assert!(store.active_runs().unwrap().is_empty());
        store.run_now("test", "next", now).unwrap();
    }
}

#[test]
fn automation_preview_validates_rules_without_creating_plans_or_runs() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let result = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id":2, "method":"automation/preview",
            "params":{"schedule":{"type":"interval","anchor":0,"minutes":60}}
        }),
    );
    let times = result["result"]["occurrences"].as_array().unwrap();
    assert_eq!(times.len(), 3);
    assert_eq!(
        times[1].as_u64().unwrap() - times[0].as_u64().unwrap(),
        3_600_000
    );
    assert!(store.list().unwrap().is_empty());
    let invalid = call(
        &server,
        &mut connection,
        json!({
            "jsonrpc":"2.0", "id":3, "method":"automation/preview",
            "params":{"schedule":{"type":"weekly","timezone":"Invalid/Zone","weekdays":[1],"hour":9,"minute":0}}
        }),
    );
    assert_eq!(invalid["error"]["message"], "InvalidParams");
}

#[test]
fn automation_commands_are_shared_across_connections_and_reject_stale_edits() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(store);
    let mut first = server.connection();
    let mut second = server.connection();
    initialize(&server, &mut first);
    initialize(&server, &mut second);
    let params = json!({
        "commandId": "create", "id": "build", "expectedRevision": 0, "status": "paused",
        "definition": {"title": "Check build", "prompt": "Say hello", "directory": dir.path(),
            "session": {"type":"new"}, "schedule": {"type":"interval", "anchor": 0, "minutes": 60}}
    });
    let created = call(
        &server,
        &mut first,
        json!({"jsonrpc":"2.0", "id":2, "method":"automation/write", "params":params}),
    );
    assert_eq!(created["result"]["revision"], 1, "{created}");
    let list = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0", "id":2, "method":"automation/list", "params":{}}),
    );
    assert_eq!(list["result"]["automations"], json!([created["result"]]));
    let mut stale = params;
    stale["commandId"] = json!("stale");
    let rejected = call(
        &server,
        &mut second,
        json!({"jsonrpc":"2.0", "id":3, "method":"automation/write", "params":stale}),
    );
    assert_eq!(rejected["error"]["message"], "AutomationConflict");
}

#[test]
fn automation_retry_reconciles_the_same_accepted_turn() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let created = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":2, "method":"automation/write", "params":{
            "commandId":"create", "id":"hello", "expectedRevision":0, "status":"paused",
            "definition":{"title":"Hello", "prompt":"Say hello", "directory":dir.path(), "session":{"type":"new"},
                "schedule":{"type":"interval", "anchor":0, "minutes":60}}
        }}),
    );
    assert!(created.get("error").is_none(), "{created}");
    let dispatched = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":3, "method":"automation/run", "params":{"id":"hello", "commandId":"manual"}}),
    );
    let original: AutomationRun = serde_json::from_value(dispatched["result"].clone()).unwrap();
    let first = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    let retry = server
        .advance_automation_run(&original, ash_automation::now().unwrap())
        .unwrap();
    assert_eq!(first.thread_id, retry.thread_id);
    assert_eq!(first.turn_id, retry.turn_id);
    assert!(first.turn_id.is_some(), "{first:?}");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut observed = retry;
    while !observed.status.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
        observed = server
            .advance_automation_run(&observed, ash_automation::now().unwrap())
            .unwrap();
    }
    assert_eq!(
        observed.status,
        AutomationRunStatus::Completed,
        "{observed:?}"
    );
    assert!(observed.started_at <= observed.finished_at);
}

#[test]
fn automation_stopped_before_dispatch_does_not_create_a_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AutomationStore::open(&dir.path().join("state.db")).unwrap());
    let server = server().with_automation_store(Arc::clone(&store));
    let now = ash_automation::now().unwrap();
    let request: ash_automation::AutomationWrite = serde_json::from_value(json!({
        "command_id": "create", "id": "stopped", "expected_revision": 0, "status": "paused",
        "definition": { "title": "Stopped", "prompt": "Must not run", "directory": dir.path(),
            "session": { "type": "new" }, "schedule": { "type": "interval", "anchor": 0, "minutes": 60 } }
    })).unwrap();
    store.write(&request, now).unwrap();
    let run = store.run_now("stopped", "manual", now).unwrap();
    let stopping = store.stop_run(&run.id).unwrap();
    let stopped = server.advance_automation_run(&stopping, now).unwrap();
    assert_eq!(stopped.status, AutomationRunStatus::Stopped);
    assert!(stopped.thread_id.is_none());
    assert!(stopped.turn_id.is_none());
    assert_eq!(stopped.finished_at, Some(now));
}

#[test]
fn automation_uses_its_directory_after_another_profile_environment_opens() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let other_directory = tempfile::tempdir().unwrap();
    let runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
    let open = |directory: &std::path::Path| {
        crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .with_profile_runtime(Arc::clone(&runtime))
                .with_dir_root(directory)
                .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(
                    Arc::new(super::EchoModel),
                )))
                .without_built_in_skills(),
        )
        .unwrap()
    };
    let automation_server = open(directory.path());
    let _other_server = open(other_directory.path());
    let store = runtime.automation_store();
    let now = ash_automation::now().unwrap();
    let request: ash_automation::AutomationWrite = serde_json::from_value(json!({
        "command_id": "create", "id": "directory", "expected_revision": 0, "status": "paused",
        "definition": {"title": "Own directory", "prompt": "Say hello", "directory": directory.path(),
            "session": {"type": "new"}, "schedule": {"type": "interval", "anchor": 0, "minutes": 60}}
    })).unwrap();
    store.write(&request, now).unwrap();
    let mut observed = store.run_now("directory", "manual", now).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !observed.status.is_finished() && Instant::now() < deadline {
        observed = automation_server
            .advance_automation_run(&observed, ash_automation::now().unwrap())
            .unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        observed.status,
        AutomationRunStatus::Completed,
        "{observed:?}"
    );
    assert!(observed.turn_id.is_some());
}
