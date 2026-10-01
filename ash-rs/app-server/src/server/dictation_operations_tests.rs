use super::*;
use crate::local::ProviderModelService;
use ash_core::{InMemoryThreadStore, ThreadController};
use ash_model_provider::EchoModel;
use std::sync::Arc;

#[test]
fn closing_the_originating_connection_does_not_cancel_model_preparation() {
    let root = tempfile::tempdir().unwrap();
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    );
    let owner = server.product_host_connection();
    let owner_id = owner.connection_id;
    let (permit, gate) = std::sync::mpsc::channel();
    let gate = std::sync::Mutex::new(gate);
    let (send, receive) = std::sync::mpsc::channel();
    server
        .dictation_models
        .start(
            owner_id,
            "continued".into(),
            realtime_voice::ModelRequest {
                model_root: root.path().into(),
                model_id: "continued".into(),
                operation: realtime_voice::ModelOperation::Import {
                    source: root.path().join("absent"),
                },
            },
            move |progress| {
                let checking = progress == realtime_voice::ModelProgress::Checking;
                send.send(progress).unwrap();
                if checking {
                    gate.lock().unwrap().recv().unwrap();
                }
            },
        )
        .unwrap();
    assert_eq!(
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap(),
        realtime_voice::ModelProgress::Checking
    );
    server.close_connection(owner);
    permit.send(()).unwrap();
    // The missing package fails its validation rather than terminating as cancelled on connection close.
    assert!(matches!(
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap(),
        realtime_voice::ModelProgress::Failed { .. }
    ));
    server.dictation_models.stop(owner_id, "continued").unwrap();
}

#[test]
fn model_operations_keep_resource_progress_private_and_broadcast_shared_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_home(Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(root.path()).unwrap(),
    )));
    let mut client = server.connection();
    let mut owner = server.product_host_connection();
    let mut other = server.product_host_connection();
    let next_id = std::cell::Cell::new(1);
    let request = |method: &str, params: Value| {
        let id = next_id.get();
        next_id.set(id + 1);
        serde_json::json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}).to_string()
    };
    for connection in [&mut client, &mut owner, &mut other] {
        let response: Value = serde_json::from_str(&server.handle_json(connection,
            &request("initialize", serde_json::json!({"clientInfo":{"name":"model-test","version":"1"},"capabilities":{}})),
        )).unwrap();
        assert!(response.get("result").is_some());
    }
    let read = request(
        "dictation/model/read",
        serde_json::json!({"modelId":"custom"}),
    );
    let denied: Value = serde_json::from_str(&server.handle_json(&mut client, &read)).unwrap();
    assert_eq!(denied["error"]["message"], "PermissionRequired");
    let missing: Value = serde_json::from_str(&server.handle_json(&mut owner, &read)).unwrap();
    assert_eq!(
        missing["result"],
        serde_json::json!({"modelId":"custom","available":false,"sizeBytes":0,"stage":null})
    );
    let started: Value = serde_json::from_str(&server.handle_json(&mut owner,
        &request("dictation/model/start", serde_json::json!({"resourceId":"import","modelId":"custom","operation":{"type":"import","sourceDirectory":root.path().join("absent")}})),
    )).unwrap();
    assert!(started.get("result").is_some());
    let notifications = server.connection_notifications(&owner);
    let mut stages = Vec::new();
    loop {
        assert!(notifications.wait());
        for message in notifications.drain() {
            let event: Value = serde_json::from_str(&message).unwrap();
            if event["method"] == "dictation/model/progress" {
                assert_eq!(event["params"]["resourceId"], "import");
                assert_eq!(event["params"]["modelId"], "custom");
                stages.push(
                    event["params"]["stage"]["type"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                );
            }
        }
        if stages.last().map(String::as_str) == Some("failed") {
            break;
        }
    }
    assert_eq!(stages, ["checking", "failed"]);
    let shared = server.connection_notifications(&other).drain();
    assert!(!shared.is_empty());
    assert!(shared.iter().all(
        |message| serde_json::from_str::<Value>(message).unwrap()["method"]
            == "dictation/model/changed"
    ));
    assert!(server.connection_notifications(&client).drain().is_empty());
    let snapshot: Value = serde_json::from_str(&server.handle_json(&mut other, &read)).unwrap();
    assert_eq!(snapshot["result"]["stage"]["type"], "failed");
    let stopped: Value = serde_json::from_str(&server.handle_json(
        &mut owner,
        &request(
            "dictation/model/stop",
            serde_json::json!({"resourceId":"import"}),
        ),
    ))
    .unwrap();
    assert!(stopped.get("result").is_some());
    assert!(notifications.drain().is_empty());
    assert!(!root.path().join("dictation-models/custom").exists());
    server.close_connection(owner);
    server.close_connection(other);
    server.close_connection(client);
}

#[test]
fn dictation_requires_product_authority_and_rejects_invalid_resource_ids() {
    let server = AppServer::new(
        Arc::new(ThreadController::with_store(Arc::new(
            InMemoryThreadStore::default(),
        ))),
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    );
    let mut client = server.connection();
    let mut host = server.product_host_connection();
    for connection in [&mut client, &mut host] {
        let response: serde_json::Value = serde_json::from_str(&server.handle_json(connection,
            &serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"dictation-test","version":"1"},"capabilities":{}}}).to_string())).unwrap();
        assert!(response.get("result").is_some());
    }
    let request = serde_json::json!({"jsonrpc":"2.0", "id":2, "method":"dictation/start", "params":{"resourceId":"bad/id","backend":{"type":"local","modelId":"paraformer-large-online-ec6a3c64"}}}).to_string();
    let denied: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut client, &request)).unwrap();
    assert_eq!(denied["error"]["message"], "PermissionRequired");
    let rejected: serde_json::Value =
        serde_json::from_str(&server.handle_json(&mut host, &request)).unwrap();
    assert_eq!(
        rejected["error"]["message"],
        "InternalError: Invalid dictation resource ID"
    );
}
