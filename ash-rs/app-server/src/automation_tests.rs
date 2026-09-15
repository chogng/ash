use super::call;
use super::initialize;
use super::server;
use ash_automation::AutomationStore;
use ash_protocol::AutomationRun;
use ash_protocol::AutomationRunStatus;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

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
        crate::open_local_app_server(
            crate::LocalAppServerOptions::new(profile.path())
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
