use super::*;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[test]
fn idle_directory_cache_releases_old_services_but_preserves_live_admissions() {
    let servers = Mutex::new(BTreeMap::new());
    let mut released = Vec::new();
    let mut connected = None;
    let mut admitted = None;
    for index in 0..8 {
        let server = Arc::new(crate::server::request_dispatch::tests::server());
        released.push(Arc::downgrade(&server));
        let runtime = Arc::new(DirRuntime::default());
        runtime.last_used.store(index, Ordering::Relaxed);
        runtime.server.get_or_init(|| Arc::clone(&server));
        if index == 0 {
            connected = Some(server);
        } else if index == 1 {
            admitted = Some(Arc::clone(&runtime));
        }
        servers.lock().unwrap().insert(
            DirRuntimeKey {
                dir_root: Some(PathBuf::from(format!("project-{index}"))),
                dir_grant_source: GrantSource::HostConfiguration,
                product_services_identity: None,
            },
            runtime,
        );
    }
    prune_idle_directories(&servers).unwrap();
    assert_eq!(servers.lock().unwrap().len(), 6);
    assert!(released[0].upgrade().is_some());
    assert!(released[1].upgrade().is_some());
    assert!(released[2].upgrade().is_none());
    assert!(released[3].upgrade().is_none());
    assert!(
        released[4..]
            .iter()
            .all(|server| server.upgrade().is_some())
    );

    drop(connected);
    drop(admitted);
    prune_idle_directories(&servers).unwrap();
    assert_eq!(servers.lock().unwrap().len(), IDLE_DIRECTORY_CACHE_CAPACITY);
    assert!(
        released[..4]
            .iter()
            .all(|server| server.upgrade().is_none())
    );
    assert!(
        released[4..]
            .iter()
            .all(|server| server.upgrade().is_some())
    );
}

#[test]
fn evicted_directory_releases_its_agent_tool_graph() {
    let profile = tempfile::tempdir().unwrap();
    let roots = (0..7)
        .map(|_| tempfile::tempdir().unwrap())
        .collect::<Vec<_>>();
    let registry = ProfileAppServerRegistry::open(
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let first = registry
        .server_for(ConnectionOptions::new(
            profile.path(),
            Some(roots[0].path().to_path_buf()),
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap();
    let server = Arc::downgrade(&first);
    let agent_tools = Arc::downgrade(&first.multi_agent);
    drop(first);
    for root in &roots[1..] {
        drop(
            registry
                .server_for(ConnectionOptions::new(
                    profile.path(),
                    Some(root.path().to_path_buf()),
                    GrantSource::HostConfiguration,
                    None,
                ))
                .unwrap(),
        );
    }
    assert!(server.upgrade().is_none());
    assert!(agent_tools.upgrade().is_none());
}

#[test]
fn omitted_product_services_reuses_the_profile_configuration_and_directory_runtime() {
    let root = tempfile::tempdir().unwrap();
    let product_services = root.path().join("product-services.json");
    fs::write(
        &product_services,
        r#"{"schemaVersion":3,"githubAccount":{"clientId":"Ov23publicclient","brokerBaseUrl":"https://broker.example/"}}"#,
    )
    .unwrap();
    let host = ConnectionOptions::new(
        root.path(),
        None,
        GrantSource::HostConfiguration,
        Some(product_services.clone()),
    );
    let servers = Mutex::new(BTreeMap::new());
    let implicit = ConnectionOptions::new(root.path(), None, GrantSource::HostConfiguration, None);
    let (inherited, options) = resolve_directory(&host, &servers, implicit).unwrap();
    let (explicit, _) = resolve_directory(&host, &servers, host.clone()).unwrap();
    assert_eq!(options.product_services(), Some(product_services.as_path()));
    assert!(Arc::ptr_eq(&inherited, &explicit));

    let override_services = root.path().join("override-services.json");
    fs::write(
        &override_services,
        r#"{"schemaVersion":3,"githubAccount":{"clientId":"Ov23otherclient","brokerBaseUrl":"https://broker.example/"}}"#,
    )
    .unwrap();
    let configured = ConnectionOptions::new(
        root.path(),
        None,
        GrantSource::HostConfiguration,
        Some(override_services.clone()),
    );
    let (separate, options) = resolve_directory(&host, &servers, configured).unwrap();
    assert_eq!(
        options.product_services(),
        Some(override_services.as_path())
    );
    assert!(!Arc::ptr_eq(&inherited, &separate));
}

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

    let Err(error) = ProfileAppServerRegistry::open(host, ash_app_server_diff::compute) else {
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
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
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
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
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
    completed: mpsc::Receiver<()>,
    closed: bool,
}

#[cfg(unix)]
impl Gateway {
    fn start(registry: Arc<ProfileAppServerRegistry>) -> Self {
        let (client, host) = crate::server::request_dispatch::tests::Client::pair();
        let server = Arc::new(crate::server::request_dispatch::tests::server());
        let (done, completed) = mpsc::channel();
        let served = thread::spawn(move || {
            let (reader, writer) = ash_app_server_transport::LocalStream::pair(host).unwrap();
            let result = super::super::gateway::serve(
                registry,
                server,
                std::io::BufReader::new(reader),
                writer,
                super::super::gateway::RemoteLaunch::from_environment(),
            );
            let result = match result {
                Err(error) if crate::managed::is_peer_disconnect(&error) => Ok(()),
                result => result,
            };
            let _ = done.send(());
            result
        });
        let mut gateway = Self {
            client,
            served: Some(served),
            completed,
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
fn gateway_resolves_managed_files_across_conversations_without_granting_other_paths() {
    use serde_json::json;

    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let second_source = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(source.path().join("README.txt"), "baseline\n").unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["add", "README.txt"],
        vec![
            "-c",
            "user.name=Ash Test",
            "-c",
            "user.email=test@ash.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "baseline",
        ],
    ] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(source.path())
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let cloned = std::process::Command::new("git")
        .args(["clone", "-q"])
        .arg(source.path())
        .arg(second_source.path())
        .output()
        .unwrap();
    assert!(
        cloned.status.success(),
        "{}",
        String::from_utf8_lossy(&cloned.stderr)
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
        .unwrap(),
    );
    let mut gateway = Gateway::start(registry);
    let mut id = 1;
    let mut rpc = |method: &str, params: serde_json::Value| {
        id += 1;
        gateway.client.send(id, method, params);
        loop {
            let response = gateway.client.read();
            if response["id"] == id {
                break response;
            }
        }
    };
    let mut directories = Vec::new();
    for (name, source_root) in [
        ("file-route-a", source.path()),
        ("file-route-b", second_source.path()),
    ] {
        let created = rpc(
            "session/create",
            json!({
                "commandId": name, "title": name,
                "executionTarget": { "type": "local", "root": source_root },
            }),
        );
        assert!(created.get("error").is_none(), "{created}");
        let session = &created["result"]["session"];
        let read = rpc(
            "session/thread/read",
            json!({
                "sessionId": session["sessionId"], "threadId": session["threads"][0]["threadId"],
            }),
        );
        let root = PathBuf::from(read["result"]["directory"]["root"].as_str().unwrap());
        assert_ne!(root, dunce::canonicalize(source_root).unwrap());
        directories.push((session["sessionId"].clone(), root));
    }
    assert_ne!(directories[0].1, directories[1].1);
    let content = (1..=120)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    // Return to A after B's runtime was selected. The request carries only a resource path.
    for (session_id, root) in directories.iter().rev() {
        let resolved = rpc(
            "fs/resolvePath",
            json!({ "path": root.join("hundred.txt") }),
        );
        assert!(resolved.get("error").is_none(), "{resolved}");
        assert_eq!(
            resolved["result"]["target"],
            json!({
                "type": "session", "sessionDirectory": { "sessionId": session_id, "path": root },
            })
        );
        let selector = &resolved["result"]["target"]["sessionDirectory"];
        let written = rpc(
            "fs/writeFile",
            json!({
                "sessionDirectory": selector, "path": "hundred.txt", "content": content,
                "options": { "mode": "create" },
            }),
        );
        assert!(written.get("error").is_none(), "{written}");
        assert_eq!(
            fs::read_to_string(root.join("hundred.txt")).unwrap(),
            content
        );
    }
    let denied = rpc(
        "fs/resolvePath",
        json!({ "path": outside.path().join("unknown.txt") }),
    );
    assert_eq!(denied["error"]["data"]["kind"], "PermissionRequired");
    let traversal = rpc(
        "fs/resolvePath",
        json!({ "path": directories[0].1.join("../unknown.txt") }),
    );
    assert_eq!(traversal["error"]["code"], -32602);
    assert!(!source.path().join("hundred.txt").exists());
    assert!(!outside.path().join("unknown.txt").exists());
}

#[cfg(unix)]
#[test]
fn gateway_directory_startup_leaves_profile_and_other_routes_available() {
    let profile = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
        .unwrap(),
    );
    registry
        .server_for(registry.local_options(second.path()))
        .unwrap();
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
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
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
    // Connection cleanup must finish while shared initialization is still blocked.
    gateway
        .completed
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    drop(held);
    drop(gateway);
    let server = registry
        .server_for(registry.local_options(directory.path()))
        .unwrap();
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
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
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

#[test]
fn cancelling_one_directory_waiter_preserves_initialization_for_another_waiter() {
    use ash_async_utils::CancellationSource;
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
            ash_app_server_diff::compute,
        )
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
    let first = CancellationSource::new();
    let second = CancellationSource::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let held = opening.opening.lock().unwrap();
    runtime.block_on(async {
        let first_token = first.token();
        let second_token = second.token();
        let first_wait = registry.open_local_session(directory.path(), &first_token);
        let second_wait = registry.open_local_session(directory.path(), &second_token);
        tokio::pin!(first_wait, second_wait);
        // Poll both submissions before cancelling, ensuring the second has a live request.
        tokio::select! { _ = &mut first_wait => panic!("startup gate was bypassed"), _ = &mut second_wait => panic!("startup gate was bypassed"), _ = tokio::time::sleep(Duration::from_millis(30)) => {} }
        first.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(3), first_wait).await.unwrap().is_err());
        drop(held);
        let server = tokio::time::timeout(Duration::from_secs(3), second_wait).await.unwrap().unwrap();
        let found = registry.server_for(registry.local_options(directory.path())).unwrap();
        assert!(Arc::ptr_eq(&server, &found));
        assert_eq!(registry.ready_servers().unwrap().len(), 1);
    });
}

#[test]
fn shared_directory_waiters_do_not_occupy_workers_needed_by_other_directories() {
    use ash_async_utils::CancellationSource;
    let profile = tempfile::tempdir().unwrap();
    let blocked = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let registry = ProfileAppServerRegistry::open(
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let shared = blocked_directory(&registry, blocked.path());
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let waits = (0..8).map(|_| registry.open_local_session(blocked.path(), &token));
        let waits = futures::future::join_all(waits);
        tokio::pin!(waits);
        tokio::select! { _ = &mut waits => panic!("shared initialization is pending"), _ = tokio::time::sleep(Duration::from_millis(30)) => {} }
        let found = tokio::time::timeout(Duration::from_secs(3), registry.open_local_session(other.path(), &token)).await.unwrap().unwrap();
        assert_eq!(registry.ready_servers().unwrap().len(), 1);
        cancellation.cancel();
        assert!(tokio::time::timeout(Duration::from_secs(3), waits).await.unwrap().iter().all(Result::is_err));
        assert_eq!(registry.startup.waiters.load(Ordering::Acquire), 0);
        assert!(matches!(&*shared.opening.lock().unwrap(), DirectoryOpening::Running { waiters } if waiters.is_empty()));
        assert!(Arc::ptr_eq(&found, &registry.server_for(registry.local_options(other.path())).unwrap()));
    });
    assert!(finish_directory(&shared, Err("fixture initialization finished".into())).is_err());
}

fn blocked_directory(registry: &ProfileAppServerRegistry, root: &Path) -> Arc<DirRuntime> {
    let directory = Arc::new(DirRuntime::default());
    *directory.opening.lock().unwrap() = DirectoryOpening::Running {
        waiters: BTreeMap::new(),
    };
    registry.servers.lock().unwrap().insert(
        DirRuntimeKey {
            dir_root: Some(dunce::canonicalize(root).unwrap()),
            dir_grant_source: GrantSource::UserConfig,
            product_services_identity: None,
        },
        Arc::clone(&directory),
    );
    directory
}

async fn wait_for_directory_waiters(directory: &DirRuntime, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !matches!(&*directory.opening.lock().unwrap(), DirectoryOpening::Running { waiters } if waiters.len() == count) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("directory requests did not register");
}

#[tokio::test]
async fn cancelling_directory_wait_removes_registration_without_further_traffic() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = ProfileAppServerRegistry::open(
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let directory = blocked_directory(&registry, root.path());
    let cancellation = ash_async_utils::CancellationSource::new();
    let token = cancellation.token();
    let mut wait = Box::pin(registry.open_local_session(root.path(), &token));
    tokio::select! {
        _ = &mut wait => panic!("initialization completed before release"),
        () = wait_for_directory_waiters(&directory, 1) => {}
    }

    cancellation.cancel();
    assert_eq!(
        wait.await.err().as_deref(),
        Some("Directory connection closed")
    );

    let opening = directory.opening.lock().unwrap();
    assert!(matches!(&*opening, DirectoryOpening::Running { waiters } if waiters.is_empty()));
    assert_eq!(registry.startup.waiters.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn dropping_directory_wait_removes_registration_and_preserves_other_waiters() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = ProfileAppServerRegistry::open(
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let directory = blocked_directory(&registry, root.path());
    let cancellation = ash_async_utils::CancellationSource::new();
    let token = cancellation.token();
    let mut abandoned = Box::pin(registry.open_local_session(root.path(), &token));
    let mut remaining = Box::pin(registry.open_local_session(root.path(), &token));
    tokio::select! {
        _ = &mut abandoned => panic!("initialization completed before release"),
        _ = &mut remaining => panic!("initialization completed before release"),
        () = wait_for_directory_waiters(&directory, 2) => {}
    }

    drop(abandoned);

    assert!(
        matches!(&*directory.opening.lock().unwrap(), DirectoryOpening::Running { waiters } if waiters.len() == 1)
    );
    assert_eq!(registry.startup.waiters.load(Ordering::Acquire), 1);
    let server = Arc::new(crate::server::request_dispatch::tests::server());
    finish_directory(&directory, Ok(Arc::clone(&server))).unwrap();
    assert!(Arc::ptr_eq(&remaining.await.unwrap(), &server));
    assert_eq!(registry.startup.waiters.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn failed_directory_initialization_completes_waiters_and_allows_a_new_attempt() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = ProfileAppServerRegistry::open(
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let directory = blocked_directory(&registry, root.path());
    let cancellation = ash_async_utils::CancellationSource::new();
    let token = cancellation.token();
    let mut wait = Box::pin(registry.open_local_session(root.path(), &token));
    tokio::select! {
        _ = &mut wait => panic!("initialization completed before release"),
        () = wait_for_directory_waiters(&directory, 1) => {}
    }

    assert!(finish_directory(&directory, Err("initialization failed".into())).is_err());
    assert_eq!(wait.await.err().as_deref(), Some("initialization failed"));
    assert!(
        matches!(&*directory.opening.lock().unwrap(), DirectoryOpening::Failed(error) if error == "initialization failed")
    );
    assert_eq!(registry.startup.waiters.load(Ordering::Acquire), 0);

    // The retry creates a real directory runtime. Bound I/O without treating its cold
    // startup latency under the full suite as part of the waiter/retry contract.
    let server = tokio::time::timeout(
        Duration::from_secs(10),
        registry.open_local_session(root.path(), &token),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(
        *directory.opening.lock().unwrap(),
        DirectoryOpening::Idle
    ));
    let found = registry
        .server_for(registry.local_options(root.path()))
        .unwrap();
    assert!(Arc::ptr_eq(&server, &found));
    assert_eq!(registry.ready_servers().unwrap().len(), 1);
}

#[test]
fn ide_windows_are_discovered_across_real_profile_directory_runtimes() {
    let profile = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir_in(first.path()).unwrap();
    let active_file = second.path().canonicalize().unwrap().join("lib.rs");
    std::fs::write(&active_file, "disk").unwrap();
    let registry = ProfileAppServerRegistry::open(
        ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None),
        ash_app_server_diff::compute,
    )
    .unwrap();
    let editor_server = registry
        .server_for(ConnectionOptions::new(
            profile.path(),
            Some(first.path().to_path_buf()),
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap();
    let tui_server = registry
        .server_for(ConnectionOptions::new(
            profile.path(),
            Some(second.path().to_path_buf()),
            GrantSource::HostConfiguration,
            None,
        ))
        .unwrap();
    assert!(!Arc::ptr_eq(&editor_server, &tui_server));
    let mut editor = editor_server.product_host_connection();
    let mut tui = tui_server.product_host_connection();
    for (server, connection) in [(&editor_server, &mut editor), (&tui_server, &mut tui)] {
        let initialized = crate::tests::call(
            server,
            connection,
            serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"ide-test","version":"1"}}}),
        );
        assert!(initialized.get("error").is_none(), "{initialized}");
    }
    let registered = crate::tests::call(
        &editor_server,
        &mut editor,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"ide/request","params":{"type":"register","title":"First project","roots":[first.path()],"windowKey":"01234567890123456789012345678901"}}),
    );
    assert!(registered.get("error").is_none(), "{registered}");
    let listed = crate::tests::call(
        &tui_server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"ide/request","params":{"type":"list"}}),
    );
    assert_eq!(
        listed["result"]["windows"][0]["id"],
        registered["result"]["window"]["id"]
    );

    let mut another_editor = editor_server.product_host_connection();
    let response = crate::tests::call(
        &editor_server,
        &mut another_editor,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"other-ide","version":"1"}}}),
    );
    assert!(response.get("error").is_none(), "{response}");
    let another = crate::tests::call(
        &editor_server,
        &mut another_editor,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"ide/request","params":{"type":"register","title":"Another window in the same project","roots":[first.path()],"windowKey":"01234567890123456789012345678902"}}),
    );
    assert!(another.get("error").is_none(), "{another}");
    let connected = crate::tests::call(
        &tui_server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"ide/request","params":{"type":"attach","windowKey":"01234567890123456789012345678901"}}),
    );
    assert!(connected.get("error").is_none(), "{connected}");
    let session = crate::tests::call(
        &tui_server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"session/create","params":{"commandId":"ide-context-session","title":"IDE context","executionTarget":{"type":"local","root":second.path()}}}),
    );
    assert!(session.get("error").is_none(), "{session}");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread_id = tui_server
        .threads()
        .list_threads()
        .unwrap()
        .into_iter()
        .find(|thread| thread.session_id.as_str() == session_id)
        .unwrap()
        .thread_id;
    let params = serde_json::json!({"type":"context","sessionId":session_id,"threadId":thread_id});
    let notifications = editor_server.connection_notifications(&editor);
    std::thread::scope(|scope| {
        let context = scope.spawn(|| {
            let response = tui_server.handle_json(
                &mut tui,
                &serde_json::json!({"jsonrpc":"2.0","id":5,"method":"ide/request","params":params})
                    .to_string(),
            );
            // A failed context request must also wake the test's reverse-RPC reader.
            notifications.close();
            response
        });
        let mut requested = false;
        while notifications.wait() {
            for raw in notifications.drain() {
                let request: serde_json::Value = serde_json::from_str(&raw).unwrap();
                if request["method"] != "ide/hostRequest" {
                    continue;
                }
                requested = true;
                assert_eq!(
                    request["params"]["roots"],
                    serde_json::json!([ash_file_access::Dir::open_local(second.path())
                        .unwrap()
                        .canonical_path()])
                );
                editor_server.handle_product_host_response(&editor, serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"type":"context","context":{"activeFile":{"path":active_file,"version":2,"selections":[{"startLine":1,"startColumn":1,"endLine":1,"endColumn":8,"text":"unsaved","truncated":false}]},"openTabs":[active_file],"dirtyFiles":[active_file]}}})).unwrap();
            }
        }
        let response: serde_json::Value = serde_json::from_str(&context.join().unwrap()).unwrap();
        assert!(response.get("error").is_none(), "{response}");
        assert!(requested, "IDE context must reach the selected window");
        assert_eq!(
            response["result"]["context"]["activeFile"]["selections"][0]["text"],
            "unsaved"
        );
        assert_eq!(
            response["result"]["context"]["openTabs"],
            serde_json::json!([active_file])
        );
        assert_eq!(
            response["result"]["context"]["dirtyFiles"],
            serde_json::json!([active_file])
        );
        assert_eq!(
            response["result"]["window"]["id"],
            registered["result"]["window"]["id"]
        );
    });
    editor_server.close_connection(editor);
    let listed = crate::tests::call(
        &tui_server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"ide/request","params":{"type":"list"}}),
    );
    assert!(listed.get("error").is_none(), "{listed}");
    assert_eq!(listed["result"]["preferred"]["type"], "unavailable");
    assert_eq!(
        listed["result"]["selected"]["id"], registered["result"]["window"]["id"],
        "an unavailable attachment remains switchable"
    );
    let disconnected = crate::tests::call(
        &tui_server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":7,"method":"ide/request","params":{"type":"disconnect"}}),
    );
    assert_eq!(disconnected["result"]["window"], serde_json::Value::Null);
    assert_eq!(
        listed["result"]["windows"][0]["id"],
        another["result"]["window"]["id"]
    );
    editor_server.close_connection(another_editor);
    let listed = crate::tests::call(
        &tui_server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":8,"method":"ide/request","params":{"type":"list"}}),
    );
    assert_eq!(listed["result"]["windows"], serde_json::json!([]));
    tui_server.close_connection(tui);
}
