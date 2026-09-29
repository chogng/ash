use super::*;
use std::io::BufReader;
use std::sync::mpsc;

#[cfg(unix)]
struct TestGateway {
    client: crate::server::request_dispatch::tests::Client,
    completed: mpsc::Receiver<io::Result<()>>,
    served: Option<thread::JoinHandle<()>>,
    closed: bool,
    marker: PathBuf,
    _profile: tempfile::TempDir,
}

#[cfg(unix)]
impl TestGateway {
    fn close(&mut self) {
        self.client.close();
        self.closed = true;
    }
}

#[cfg(unix)]
impl Drop for TestGateway {
    fn drop(&mut self) {
        if !self.closed {
            self.client.close();
        }
        if let Some(served) = self.served.take() {
            served.join().unwrap();
        }
    }
}

#[cfg(unix)]
fn stalled_gateway(timeout: std::time::Duration) -> TestGateway {
    gateway_with_ssh(timeout, |marker| {
        format!(
            "IFS= read -r initialize\nprintf '%s' $$ > '{}'\nwhile IFS= read -r request; do :; done\n",
            marker.display()
        )
    })
}

#[cfg(unix)]
fn gateway_with_ssh(
    timeout: std::time::Duration,
    script: impl FnOnce(&std::path::Path) -> String,
) -> TestGateway {
    use std::os::unix::fs::PermissionsExt;
    let profile = tempfile::tempdir().unwrap();
    let marker = profile.path().join("ssh-state");
    let executable = profile.path().join("ssh");
    std::fs::write(&executable, format!("#!/bin/sh\n{}", script(&marker))).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let remote = ash_remote::RemoteProfile::new(
        ash_remote::SshTarget::new(
            ash_remote::SshHost::parse("stalled-host").unwrap(),
            ash_remote::RemoteDirPath::parse("/workspace").unwrap(),
        ),
        ash_remote::RemoteRuntime::new("/runtime/ash-remote-server").unwrap(),
    );
    ash_remote_profile_store::RemoteConnectionProfileStore::from_profile_root(profile.path())
        .activate(&remote)
        .unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ash_app_server_daemon::ConnectionOptions::new(
            profile.path(),
            None,
            ash_app_server_daemon::GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    let server = Arc::new(crate::server::request_dispatch::tests::server());
    let (mut client, host) = crate::server::request_dispatch::tests::Client::pair();
    let (done, completed) = mpsc::channel();
    let served = thread::spawn(move || {
        let (reader, host) = ash_app_server_transport::LocalStream::pair(host).unwrap();
        let reader = BufReader::new(reader);
        let result = serve(
            registry,
            server,
            reader,
            host,
            RemoteLaunch {
                executable: executable.into_os_string(),
                initialize_timeout: timeout,
            },
        );
        let result = match result {
            Err(error) if crate::managed::is_peer_disconnect(&error) => Ok(()),
            result => result,
        };
        let _ = done.send(result);
    });
    client.initialize();
    TestGateway {
        client,
        completed,
        served: Some(served),
        closed: false,
        marker,
        _profile: profile,
    }
}

#[cfg(unix)]
fn wait_for_ssh(marker: &std::path::Path) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if let Ok(pid) = std::fs::read_to_string(marker) {
            if !pid.is_empty() {
                return pid;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "SSH did not receive initialize"
        );
        thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(unix)]
#[test]
fn stalled_ssh_initialize_leaves_local_requests_available_and_eof_reaps_the_child() {
    let mut gateway = stalled_gateway(std::time::Duration::from_secs(10));
    gateway
        .client
        .send(2, "session/list", serde_json::json!({}));
    let pid = wait_for_ssh(&gateway.marker);
    gateway.client.send(3, "model/list", serde_json::json!({}));
    gateway.client.send(
        4,
        "language/cancel",
        serde_json::json!({"operationId":"not-started"}),
    );
    let mut responses = [gateway.client.read(), gateway.client.read()];
    responses.sort_by_key(|response| response["id"].as_u64());
    assert_eq!(responses[0]["id"], 3);
    assert!(responses[0]["result"].is_object());
    assert_eq!(responses[1]["id"], 4);
    assert!(responses[1]["result"].is_object());
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
    gateway.served.take().unwrap().join().unwrap();
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", &pid])
            .output()
            .unwrap()
            .status
            .success(),
        "SSH child survived renderer EOF"
    );
}

#[cfg(unix)]
#[test]
fn ssh_initialize_timeout_completes_the_catalog_and_preserves_the_gateway() {
    let mut gateway = stalled_gateway(std::time::Duration::from_secs(1));
    gateway
        .client
        .send(2, "session/list", serde_json::json!({}));
    let pid = wait_for_ssh(&gateway.marker);
    let failure = gateway.client.read();
    assert_eq!(failure["id"], 2);
    assert_eq!(failure["error"]["code"], -32603);
    assert!(
        failure["error"]["message"]
            .as_str()
            .unwrap()
            .contains("deadline")
    );
    gateway.client.send(3, "model/list", serde_json::json!({}));
    let response = gateway.client.read();
    assert_eq!(response["id"], 3);
    assert!(response["result"].is_object());
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
    gateway.served.take().unwrap().join().unwrap();
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", &pid])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[cfg(unix)]
#[test]
fn ssh_catalog_waits_for_initialize_and_maps_the_remote_response_to_the_client() {
    let server = crate::server::request_dispatch::tests::server();
    let initialize = server.handle_json(
        &mut server.product_host_connection(),
        &serde_json::json!({
            "jsonrpc":"2.0", "id":1, "method":"initialize",
            "params":{"clientInfo":{"name":"dispatch-test","version":"1"},"capabilities":{}}
        })
        .to_string(),
    );
    let catalog =
        serde_json::json!({"jsonrpc":"2.0", "id":catalog_request_id(1), "result":{"sessions":[]}})
            .to_string();
    let mut gateway = gateway_with_ssh(std::time::Duration::from_secs(10), |marker| {
        format!(
            "IFS= read -r initialize\nprintf '%s\\n' '{}'\nIFS= read -r request\nprintf '%s' \"$request\" > '{}'\nprintf '%s\\n' '{}'\nwhile IFS= read -r request; do :; done\n",
            initialize.replace('\'', "'\"'\"'"),
            marker.display(),
            catalog,
        )
    });
    gateway
        .client
        .send(2, "session/list", serde_json::json!({}));
    let response = gateway.client.read();
    assert_eq!(
        response,
        serde_json::json!({"jsonrpc":"2.0", "id":2, "result":{"sessions":[]}})
    );
    let forwarded: Value =
        serde_json::from_str(&std::fs::read_to_string(&gateway.marker).unwrap()).unwrap();
    assert_eq!(forwarded["id"], catalog_request_id(1));
    assert_eq!(forwarded["method"], "session/list");
    gateway.client.send(3, "model/list", serde_json::json!({}));
    let local = gateway.client.read();
    assert_eq!(local["id"], 3);
    assert!(local["result"].is_object());
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
    gateway.served.take().unwrap().join().unwrap();
}

#[cfg(unix)]
#[test]
fn saturated_ssh_route_rejects_new_work_without_blocking_local_requests() {
    let mut gateway = stalled_gateway(std::time::Duration::from_secs(10));
    for id in 2..=66 {
        gateway.client.send(id, "session/create", serde_json::json!({"executionTarget":{"type":"ssh","host":"stalled-host","root":"/workspace"}}));
    }
    let pid = wait_for_ssh(&gateway.marker);
    let failure = gateway.client.read();
    assert_eq!(failure["id"], 66);
    assert_eq!(failure["error"]["code"], -32000);
    gateway.client.send(67, "model/list", serde_json::json!({}));
    let response = gateway.client.read();
    assert_eq!(response["id"], 67);
    assert!(response["result"].is_object());
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
    gateway.served.take().unwrap().join().unwrap();
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", &pid])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn agents_gateway_serves_the_catalog_while_another_request_is_running() {
    use crate::server::request_dispatch::tests::Client;
    use crate::server::request_dispatch::tests::blocking_catalog_server;
    let root = tempfile::tempdir().unwrap();
    let registry = Arc::new(
        ProfileAppServerRegistry::open(ash_app_server_daemon::ConnectionOptions::new(
            root.path(),
            None,
            ash_app_server_daemon::GrantSource::HostConfiguration,
            None,
        ))
        .unwrap(),
    );
    let (server, entered, release) = blocking_catalog_server();
    let (mut client, host) = Client::pair();
    let served = thread::spawn(move || {
        serve(
            registry,
            server,
            BufReader::new(host.try_clone().unwrap()),
            host,
            RemoteLaunch::from_environment(),
        )
    });
    client.initialize();
    client.send(2, "model/list", serde_json::json!({}));
    entered
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    client.send(3, "session/list", serde_json::json!({}));
    client.send(
        4,
        "language/cancel",
        serde_json::json!({"operationId":"not-started"}),
    );
    let first = client.read();
    let second = client.read();
    assert!(
        [&first, &second]
            .iter()
            .any(|message| message["id"] == 3 && message["result"].is_object())
    );
    assert!(
        [&first, &second]
            .iter()
            .any(|message| message["id"] == 4 && message["result"].is_object())
    );
    drop(release);
    assert_eq!(client.read()["id"], 2);
    client.close();
    served.join().unwrap().unwrap();
}

#[test]
fn remote_catalog_preserves_each_session_root_and_deduplicates_host_views() {
    let index: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::new()));
    let key = ("build-host".to_owned(), "/work/first".to_owned());
    let mut remote = serde_json::json!({
        "jsonrpc":"2.0", "id":catalog_request_id(1),
        "result":{"sessions":[
            {"sessionId":"one","threads":[{"threadId":"thread-one"}],"executionTarget":{"type":"local","root":"/work/first"}},
            {"sessionId":"two","threads":[{"threadId":"thread-two"}],"executionTarget":{"type":"local","root":"/work/second"}}
        ]}
    });
    annotate_remote_sessions(&mut remote, &key, &index);
    assert_eq!(
        remote["result"]["sessions"][1]["executionTarget"],
        serde_json::json!({"type":"ssh","host":"build-host","root":"/work/second"})
    );
    assert_eq!(
        index.lock().unwrap().get("thread-two"),
        Some(&("build-host".into(), "/work/second".into()))
    );

    let catalogs: Catalogs = Arc::new(Mutex::new(BTreeMap::from([(
        1,
        PendingCatalog {
            response: serde_json::json!({"jsonrpc":"2.0","id":7,"result":{"sessions":[]}}),
            remaining: 2,
        },
    )])));
    let (outbound, received) = crate::server::message_queue::outbound_queue(16);
    complete_catalog(&catalogs, 1, remote.clone(), &outbound);
    assert_eq!(catalogs.lock().unwrap().get(&1).unwrap().remaining, 1);
    complete_catalog(&catalogs, 1, remote, &outbound);
    let merged: Value = serde_json::from_str(&received.recv().unwrap().raw).unwrap();
    assert_eq!(merged["result"]["sessions"].as_array().unwrap().len(), 2);
}

#[test]
fn host_request_route_restores_the_issuing_server_id() {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "browser-host:1:2",
        "method": "browser/open",
        "params": {}
    });
    let tagged = tag_host_request(request.to_string(), 5);
    let tagged: Value = serde_json::from_str(&tagged).unwrap();
    let response = serde_json::json!({"jsonrpc":"2.0","id":tagged["id"],"result":{}});
    let (route, original) = untag_host_response(&response).unwrap();
    assert_eq!(route, 5);
    assert_eq!(original["id"], "browser-host:1:2");
}

#[cfg(unix)]
fn remote_initialize_result() -> String {
    let server = crate::server::request_dispatch::tests::server();
    server.handle_json(
        &mut server.product_host_connection(),
        &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"dispatch-test","version":"1"},"capabilities":{}}}).to_string(),
    )
}

#[cfg(unix)]
#[test]
fn ssh_stop_is_delivered_while_all_ordinary_pending_slots_are_occupied() {
    let initialize = remote_initialize_result();
    let catalog = serde_json::json!({"jsonrpc":"2.0","id":catalog_request_id(1),"result":{"sessions":[{"sessionId":"remote-session","threads":[],"executionTarget":{"type":"local","root":"/workspace"}}]}}).to_string();
    let mut gateway = gateway_with_ssh(std::time::Duration::from_secs(10), |marker| {
        format!(
            "IFS= read -r initialize\nprintf '%s\\n' '{}'\nIFS= read -r request\nprintf '%s\\n' '{}'\nwhile IFS= read -r request; do\ncase \"$request\" in\n*'\"type\":\"stop\"'*) printf '%s' \"$request\" > '{}'; printf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":67,\"result\":{{}}}}';;\nesac\ndone\n",
            initialize.replace('\'', "'\"'\"'"),
            catalog,
            marker.display(),
        )
    });
    gateway
        .client
        .send(2, "session/list", serde_json::json!({}));
    assert_eq!(
        gateway.client.read()["result"]["sessions"][0]["sessionId"],
        "remote-session"
    );
    for id in 3..=66 {
        gateway.client.send(
            id,
            "session/thread/read",
            serde_json::json!({"sessionId":"remote-session","threadId":"remote-thread"}),
        );
    }
    gateway.client.send(67, "session/request", serde_json::json!({"commandId":"stop-remote-session","sessionId":"remote-session","request":{"type":"stop"}}));
    let response = gateway.client.read();
    assert_eq!(response["id"], 67);
    assert!(response["result"].is_object(), "{response}");
    let forwarded: Value = serde_json::from_str(&wait_for_ssh(&gateway.marker)).unwrap();
    assert_eq!(forwarded["params"]["request"]["type"], "stop");
    gateway.client.send(68, "model/list", serde_json::json!({}));
    assert_eq!(gateway.client.read()["id"], 68);
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
    gateway.served.take().unwrap().join().unwrap();
}

#[cfg(unix)]
#[test]
fn ssh_host_reply_overflow_ends_only_its_route_and_completes_each_request_once() {
    use std::io::Write;
    let mut gateway = gateway_with_ssh(std::time::Duration::from_secs(10), |marker| {
        format!(
            "IFS= read -r initialize\nprintf '%s' $$ > '{}'\ni=0\nwhile [ \"$i\" -lt 17 ]; do\nprintf '{{\"jsonrpc\":\"2.0\",\"id\":\"host:%s\",\"method\":\"browser/open\",\"params\":{{}}}}\\n' \"$i\"\ni=$((i+1))\ndone\nwhile IFS= read -r request; do :; done\n",
            marker.display(),
        )
    });
    // The remote never completes initialize, so its writer cannot drain any of these queues.
    for id in 2..=65 {
        gateway.client.send(id, "session/create", serde_json::json!({"executionTarget":{"type":"ssh","host":"stalled-host","root":"/workspace"}}));
    }
    for _ in 0..17 {
        let host = gateway.client.read();
        assert_eq!(host["method"], "browser/open");
        writeln!(
            gateway.client.writer,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":host["id"],"result":{}})
        )
        .unwrap();
    }
    gateway
        .client
        .send(1000, "model/list", serde_json::json!({}));
    let mut completed = std::collections::BTreeSet::new();
    while completed.len() < 65 {
        let response = gateway.client.read();
        let id = response["id"].as_u64().unwrap();
        assert!(
            completed.insert(id),
            "duplicate terminal response: {response}"
        );
        if id == 1000 {
            assert!(response["result"].is_object());
        } else {
            assert!((2..=65).contains(&id), "{response}");
            assert!(response["error"].is_object(), "{response}");
        }
    }
    // A subsequent local response also proves the gateway survived the concurrent SSH EOF.
    gateway
        .client
        .send(1001, "model/list", serde_json::json!({}));
    assert_eq!(gateway.client.read()["id"], 1001);
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
    gateway.served.take().unwrap().join().unwrap();
}

#[test]
fn ssh_buffered_response_cannot_complete_an_id_already_finished_by_route_failure() {
    use std::sync::atomic::AtomicBool;
    let pending = Arc::new(Mutex::new(BTreeMap::from([(
        1,
        PendingRemoteRequests {
            closed: false,
            ids: vec![(serde_json::json!(2), RequestLane::Interactive)],
        },
    )])));
    let catalogs = Arc::new(Mutex::new(BTreeMap::new()));
    let sessions = Arc::new(Mutex::new(BTreeMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let (outbound, received) = crate::server::message_queue::outbound_queue(16);
    fail_remote_requests(
        1,
        &io::Error::from(io::ErrorKind::BrokenPipe),
        &pending,
        &catalogs,
        &outbound,
    );
    let failure: Value = serde_json::from_str(&received.recv().unwrap().raw).unwrap();
    assert_eq!(failure["id"], 2);
    assert!(failure["error"].is_object());
    let reader = JsonlReader::new(
        std::io::Cursor::new("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n"),
        DEFAULT_MAX_MESSAGE_BYTES,
    );
    read_remote_messages(
        reader,
        ("host".into(), "/workspace".into()),
        1,
        alive,
        outbound,
        sessions,
        catalogs,
        pending,
    );
    assert!(
        received.recv().is_err(),
        "a late response cannot follow route failure"
    );
}
