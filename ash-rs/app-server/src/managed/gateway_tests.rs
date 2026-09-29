use super::*;
use std::io::BufReader;

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
    let (outbound, received) = mpsc::sync_channel(16);
    complete_catalog(&catalogs, 1, remote.clone(), &outbound);
    assert!(received.try_recv().is_err());
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
