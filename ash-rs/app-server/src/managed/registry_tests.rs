use super::*;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[test]
fn open_rejects_invalid_product_services_before_managed_endpoint_startup() {
    let root = tempfile::tempdir().unwrap();
    let product_services = root.path().join("product-services.json");
    fs::write(&product_services, "{}\n").unwrap();
    let host = ConnectionOptions::new(
        root.path().join("profile"),
        None,
        GrantSource::HostConfiguration,
        Some(product_services),
    );

    let Err(error) = ProfileAppServerRegistry::open(host) else {
        panic!("invalid product services were accepted");
    };

    assert!(error.contains("product services configuration is invalid"));
}

#[test]
fn opening_one_directory_leaves_other_directories_and_profile_checks_available() {
    let profile = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ConnectionOptions::new(
            profile.path(),
            None,
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    let opening = Arc::new(DirRuntime::default());
    let ready = Arc::new(DirRuntime::default());
    let server = Arc::new(crate::server::request_dispatch::tests::server());
    ready.server.get_or_init(|| Arc::clone(&server));
    for (root, runtime) in [(first.path(), Arc::clone(&opening)), (second.path(), ready)] {
        registry.servers.lock().unwrap().insert(
            DirRuntimeKey {
                dir_root: Some(dunce::canonicalize(root).unwrap()),
                dir_grant_source: GrantSource::HostConfiguration,
                product_services_identity: None,
            },
            runtime,
        );
    }
    let held = opening.opening.lock().unwrap();
    let (entered, waiting) = mpsc::channel();
    let first_registry = Arc::clone(&registry);
    let first_options = ConnectionOptions::new(
        profile.path(),
        Some(first.path().to_path_buf()),
        GrantSource::HostConfiguration,
        None,
    );
    let first_open = thread::spawn(move || {
        entered.send(()).unwrap();
        first_registry.server_for(first_options)
    });
    waiting.recv_timeout(Duration::from_secs(3)).unwrap();
    let (done, completed) = mpsc::channel();
    let second_registry = Arc::clone(&registry);
    let second_options = ConnectionOptions::new(
        profile.path(),
        Some(second.path().to_path_buf()),
        GrantSource::HostConfiguration,
        None,
    );
    let lookup = thread::spawn(move || {
        let found = second_registry.server_for(second_options).unwrap();
        assert_eq!(second_registry.active_terminal_count(), 0);
        assert!(!second_registry.queue_needs_host().unwrap());
        done.send(found).unwrap();
    });
    let found = completed.recv_timeout(Duration::from_secs(3));
    drop(held);
    assert!(Arc::ptr_eq(&found.unwrap(), &server));
    lookup.join().unwrap();
    first_open.join().unwrap().unwrap();
}

#[test]
fn concurrent_directory_openers_share_one_runtime() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ConnectionOptions::new(
            profile.path(),
            None,
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    let options = ConnectionOptions::new(
        profile.path(),
        Some(directory.path().to_path_buf()),
        GrantSource::HostConfiguration,
        None,
    );
    let gate = Arc::new(std::sync::Barrier::new(3));
    let opening = (0..2)
        .map(|_| {
            let registry = Arc::clone(&registry);
            let options = options.clone();
            let gate = Arc::clone(&gate);
            thread::spawn(move || {
                gate.wait();
                registry.server_for(options).unwrap()
            })
        })
        .collect::<Vec<_>>();
    gate.wait();
    let servers = opening
        .into_iter()
        .map(|opener| opener.join().unwrap())
        .collect::<Vec<_>>();
    assert!(Arc::ptr_eq(&servers[0], &servers[1]));
    assert_eq!(registry.ready_servers().unwrap().len(), 1);
}

#[cfg(unix)]
struct Gateway {
    client: crate::server::request_dispatch::tests::Client,
    served: Option<thread::JoinHandle<io::Result<()>>>,
    closed: bool,
}

#[cfg(unix)]
impl Gateway {
    fn start(registry: Arc<ProfileAppServerRegistry>) -> Self {
        let (client, host) = crate::server::request_dispatch::tests::Client::pair();
        let server = Arc::new(crate::server::request_dispatch::tests::server());
        let served = thread::spawn(move || {
            let (reader, writer) = ash_app_server_transport::LocalStream::pair(host).unwrap();
            let result = super::super::gateway::serve(
                registry,
                server,
                std::io::BufReader::new(reader),
                writer,
                super::super::gateway::RemoteLaunch::from_environment(),
            );
            match result {
                Err(error) if crate::managed::is_peer_disconnect(&error) => Ok(()),
                result => result,
            }
        });
        let mut gateway = Self {
            client,
            served: Some(served),
            closed: false,
        };
        gateway.client.initialize();
        gateway
    }
}

#[cfg(unix)]
impl Drop for Gateway {
    fn drop(&mut self) {
        if !self.closed {
            self.client.close();
        }
        let result = self.served.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap().unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn gateway_directory_startup_leaves_profile_and_other_routes_available() {
    let profile = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ConnectionOptions::new(
            profile.path(),
            None,
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    registry.server_for_local_session(second.path()).unwrap();
    let opening = Arc::new(DirRuntime::default());
    registry.servers.lock().unwrap().insert(
        DirRuntimeKey {
            dir_root: Some(dunce::canonicalize(first.path()).unwrap()),
            dir_grant_source: GrantSource::UserConfig,
            product_services_identity: None,
        },
        Arc::clone(&opening),
    );
    let mut gateway = Gateway::start(registry);
    // Declared after the gateway so a failed read releases startup before joining its owner.
    let held = opening.opening.lock().unwrap();
    gateway.client.send(
        2,
        "session/create",
        serde_json::json!({
            "commandId":"create-first","title":"First", "executionTarget":{"type":"local","root":first.path()}
        }),
    );
    gateway.client.send(3, "model/list", serde_json::json!({}));
    gateway.client.send(
        4,
        "language/cancel",
        serde_json::json!({"operationId":"not-started"}),
    );
    gateway.client.send(
        5,
        "session/create",
        serde_json::json!({
            "commandId":"create-second","title":"Second", "executionTarget":{"type":"local","root":second.path()}
        }),
    );
    let mut responses = Vec::new();
    while responses.len() < 3 {
        let response = gateway.client.read();
        if let Some(id) = response["id"].as_u64() {
            assert!(response["result"].is_object(), "{response}");
            responses.push(id);
        }
    }
    responses.sort();
    assert_eq!(responses, [3, 4, 5]);
    drop(held);
    loop {
        let response = gateway.client.read();
        if response["id"] == 2 {
            assert!(response["result"].is_object(), "{response}");
            break;
        }
    }
}

#[cfg(unix)]
#[test]
fn gateway_bounds_cold_directory_requests_and_drops_them_on_disconnect() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ConnectionOptions::new(
            profile.path(),
            None,
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    let opening = Arc::new(DirRuntime::default());
    registry.servers.lock().unwrap().insert(
        DirRuntimeKey {
            dir_root: Some(dunce::canonicalize(directory.path()).unwrap()),
            dir_grant_source: GrantSource::UserConfig,
            product_services_identity: None,
        },
        Arc::clone(&opening),
    );
    let mut gateway = Gateway::start(Arc::clone(&registry));
    let held = opening.opening.lock().unwrap();
    for id in 2..=66 {
        gateway.client.send(
            id,
            "session/create",
            serde_json::json!({
                "commandId":format!("create-{id}"),"title":"Queued", "executionTarget":{"type":"local","root":directory.path()}
            }),
        );
    }
    let failure = gateway.client.read();
    assert_eq!(failure["id"], 66);
    assert_eq!(failure["error"]["code"], -32000);
    gateway.client.send(67, "model/list", serde_json::json!({}));
    let response = gateway.client.read();
    assert_eq!(response["id"], 67);
    assert!(response["result"].is_object());
    gateway.client.close();
    gateway.closed = true;
    // Keep the startup gate held until the gateway closes the route. This models a filesystem
    // operation returning after EOF; the route must release its connection without executing.
    thread::sleep(Duration::from_millis(100));
    drop(held);
    drop(gateway);
    let server = registry.server_for_local_session(directory.path()).unwrap();
    let mut connection = server.product_host_connection();
    server.handle_json(&mut connection, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"verify","version":"1"},"capabilities":{}}}"#);
    let response: serde_json::Value = serde_json::from_str(&server.handle_json(
        &mut connection,
        r#"{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}"#,
    ))
    .unwrap();
    assert!(
        response["result"]["sessions"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{response}"
    );
    server.close_connection(connection);
}

#[cfg(unix)]
#[test]
fn gateway_directory_startup_failure_completes_requests_and_preserves_the_connection() {
    let profile = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ConnectionOptions::new(
            profile.path(),
            None,
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    let mut gateway = Gateway::start(registry);
    gateway.client.send(
        2,
        "session/create",
        serde_json::json!({
            "commandId":"missing-directory","title":"Missing",
            "executionTarget":{"type":"local","root":profile.path().join("missing")}
        }),
    );
    gateway.client.send(3, "model/list", serde_json::json!({}));
    let mut responses = [gateway.client.read(), gateway.client.read()];
    responses.sort_by_key(|response| response["id"].as_u64());
    assert_eq!(responses[0]["id"], 2);
    assert_eq!(responses[0]["error"]["code"], -32603);
    assert_eq!(responses[1]["id"], 3);
    assert!(responses[1]["result"].is_object());
    gateway.client.send(
        4,
        "language/cancel",
        serde_json::json!({"operationId":"not-started"}),
    );
    let response = gateway.client.read();
    assert_eq!(response["id"], 4);
    assert!(response["result"].is_object());
}
