use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use serde_json::Value;
use serde_json::json;

use super::AppServer;
use super::ConnectionState;

#[test]
fn testing_rpc_discovers_runs_and_releases_only_the_issuing_connection() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("src")).unwrap();
    std::fs::write(
        temp.path().join("Cargo.toml"),
        "[package]\nname=\"rpc-test-fixture\"\nversion=\"0.1.0\"\nedition=\"2021\"\n[workspace]\n",
    )
    .unwrap();
    std::fs::write(temp.path().join("src/lib.rs"), "#[test]\nfn passes() {}\n").unwrap();
    let server = AppServer::new(
        Arc::new(ash_core::ThreadController::with_store(Arc::new(
            ash_core::InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(
            ash_model_provider::EchoModel,
        ))),
    )
    .with_ephemeral_env_state();
    server.env_runtime.write().unwrap().selected_grant = Some(Grant::for_environment(
        Dir::open_local(temp.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles, Permission::ExecuteCommands]),
    ));
    let mut owner = server.connection();
    let mut observer = server.connection();
    for connection in [&mut owner, &mut observer] {
        assert!(
            call(
                &server,
                connection,
                "initialize",
                json!({"clientInfo":{"name":"testing","version":"1"},"capabilities":{}})
            )["result"]
                .is_object()
        );
    }
    assert!(
        call(
            &server,
            &mut owner,
            "testing/discover",
            json!({"operationId":"catalog"})
        )["result"]
            .is_null()
    );
    let catalog = await_complete(&server, &mut owner, "catalog");
    assert_eq!(catalog["status"], "completed");
    assert_eq!(catalog["tests"][0]["name"], "passes");
    let id = catalog["tests"][0]["id"].clone();
    let denied = call(
        &server,
        &mut observer,
        "testing/run",
        json!({"operationId":"run","catalogId":"catalog","testIds":[id]}),
    );
    assert_eq!(denied["error"]["data"]["kind"], "TestingNotFound");
    assert!(
        call(
            &server,
            &mut owner,
            "testing/run",
            json!({"operationId":"run","catalogId":"catalog","testIds":[id]})
        )["result"]
            .is_null()
    );
    let run = await_complete(&server, &mut owner, "run");
    assert_eq!(run["results"][0]["state"], "passed");
    let updates: Vec<Value> = server
        .drain_notifications(&mut owner)
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|event: &Value| event["method"] == "testing/updated")
        .collect();
    assert!(
        updates
            .iter()
            .any(|update| update["params"]["result"]["state"] == "passed")
    );
    assert!(
        !server
            .drain_notifications(&mut observer)
            .iter()
            .any(|line| line.contains("testing/updated"))
    );
    assert!(
        call(
            &server,
            &mut owner,
            "testing/release",
            json!({"operationId":"run"})
        )["result"]
            .is_null()
    );
    assert_eq!(
        call(
            &server,
            &mut owner,
            "testing/read",
            json!({"operationId":"run"})
        )["error"]["data"]["kind"],
        "TestingNotFound"
    );
    let owner_id = owner.connection_id;
    server.close_connection(owner);
    assert!(matches!(
        server.testing.read(owner_id, "catalog"),
        Err(testing::TestingError::NotFound)
    ));
    server.close_connection(observer);
}

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    method: &str,
    params: Value,
) -> Value {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let request_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    serde_json::from_str(&server.handle_json(
        connection,
        &json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}).to_string(),
    ))
    .unwrap()
}

fn await_complete(server: &AppServer, connection: &mut ConnectionState, id: &str) -> Value {
    let started = Instant::now();
    loop {
        let response = call(
            server,
            connection,
            "testing/read",
            json!({"operationId":id}),
        );
        assert!(response["error"].is_null(), "{response}");
        if response["result"]["status"] != "running" {
            return response["result"].clone();
        }
        assert!(started.elapsed() < Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(10));
    }
}
