use super::*;
use std::io::BufReader;
#[cfg(unix)]
use std::sync::mpsc;

#[test]
fn debug_log_collection_tags_every_nested_binary_resource_without_touching_other_ids() {
    let response = serde_json::json!({"jsonrpc":"2.0","id":2,"result":{
        "files":[
            {"name":"app-server.log","resource":{"resourceId":"first","sha256":"digest"}},
            {"name":"app-server.log.1","resource":{"resourceId":"second","sha256":"digest"}},
            {"resource":{"resourceId":"not-a-binary-handle"}}
        ], "resourceId":"unrelated", "omittedFiles":0
    }});
    let tagged: Value =
        serde_json::from_str(&tag_resource_response(response.to_string(), 7)).unwrap();
    assert_eq!(
        tagged["result"]["files"][0]["resource"]["resourceId"],
        "gateway-resource:7:first"
    );
    assert_eq!(
        tagged["result"]["files"][1]["resource"]["resourceId"],
        "gateway-resource:7:second"
    );
    assert_eq!(
        tagged["result"]["files"][2]["resource"]["resourceId"],
        "not-a-binary-handle"
    );
    // The top-level field is not itself a binary resource contract.
    assert_eq!(tagged["result"]["resourceId"], "unrelated");
}

#[test]
fn message_history_keeps_local_profile_authority_with_remote_thread_origins() {
    let profile = tempfile::tempdir().unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry =
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap();
    let _server = registry.server_for(options).unwrap();
    let remote: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::from([(
        "remote-thread".into(),
        RemoteKey::Ssh("build-host".into(), "/work/source".into()),
    )])));
    for method in [
        "messageHistory/append",
        "messageHistory/read",
        "messageHistory/clear",
    ] {
        assert_eq!(
            selected_execution_target(
                &registry,
                &remote,
                &serde_json::json!({"method":method,"params":{"threadId":"remote-thread"}}),
            )
            .unwrap(),
            None,
            "{method} must use the local Profile even when its origin is remote"
        );
    }
}

#[test]
fn session_directory_file_requests_route_to_the_session_execution_authority() {
    let profile = tempfile::tempdir().unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry =
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap();
    let _server = registry.server_for(options).unwrap();
    let remote: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::from([(
        "remote-session".into(),
        RemoteKey::Ssh("build-host".into(), "/work/source".into()),
    )])));
    for method in [
        "fs/readDirectory",
        "fs/readFile",
        "fs/writeFile",
        "fs/copy",
        "fs/pasteSystemFiles",
    ] {
        assert_eq!(
            selected_execution_target(&registry, &remote, &serde_json::json!({
                "method":method,"params":{"sessionDirectory":{"sessionId":"remote-session","path":"/work/source"}}
            })).unwrap(),
            Some(SessionExecutionTarget::Ssh { host: "build-host".into(), root: "/work/source".into() })
        );
    }
    for method in [
        "terminal/create",
        "terminal/profile/list",
        "terminal/read",
        "terminal/write",
        "terminal/close",
        "fs/readFile",
        "fs/readBinaryFile",
        "fs/writeFile",
    ] {
        assert_eq!(
            selected_execution_target(
                &registry,
                &remote,
                &serde_json::json!({
                    "method":method,"params":{"dirId":"session:remote-session:%2Fwork%2Fsource"}
                })
            )
            .unwrap(),
            Some(SessionExecutionTarget::Ssh {
                host: "build-host".into(),
                root: "/work/source".into()
            })
        );
    }
    assert!(
        selected_execution_target(
            &registry,
            &remote,
            &serde_json::json!({
                "method":"terminal/create","params":{"dirId":"session:remote-session:relative"}
            })
        )
        .is_err()
    );
}

#[test]
fn resource_openers_follow_the_session_execution_authority() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry =
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap();
    let server = registry.server_for(options).unwrap();
    let target = SessionExecutionTarget::Local {
        root: directory.path().to_path_buf(),
    };
    server
        .threads()
        .create_thread(ash_core::CreateThreadRequest {
            agent_id: ash_protocol::AgentId::new("resource-agent").unwrap(),
            origin: ash_protocol::ThreadOrigin::Root,
            agent: None,
            session_id: SessionId::new("local-resource").unwrap(),
            thread_id: ThreadId::new("local-resource").unwrap(),
            title: "Resources".into(),
            execution_target: Some(target.clone()),
        })
        .unwrap();
    let remote: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::from([(
        "remote-resource".into(),
        RemoteKey::Ssh("build-host".into(), "/work/source".into()),
    )])));
    for method in [
        "tool/resource/open",
        "tool/app/resource/open",
        "attachment/resource/open",
        "skill/resource/open",
        "session/debugLogs/collect",
    ] {
        for (session, expected) in [
            ("local-resource", target.clone()),
            (
                "remote-resource",
                SessionExecutionTarget::Ssh {
                    host: "build-host".into(),
                    root: "/work/source".into(),
                },
            ),
        ] {
            assert_eq!(selected_execution_target(&registry, &remote, &serde_json::json!({
                "method": method, "params": {"sessionId": session, "resourceId":"connection-owned"}
            })).unwrap(), Some(expected), "{method} in {session}");
        }
        assert_eq!(
            selected_execution_target(
                &registry,
                &remote,
                &serde_json::json!({
                    "method":method, "params":{"resourceId":"connection-owned"}
                })
            )
            .unwrap(),
            None,
            "Profile resource requests retain Profile authority"
        );
    }
}

#[cfg(unix)]
#[test]
fn imported_ssh_history_is_read_by_the_local_gateway_without_opening_a_remote_agent() {
    use ash_core::ThreadStore;
    let source_profile = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let source = Arc::new(
        ash_state::SqliteThreadStore::open(source_profile.path().join("state.sqlite3")).unwrap(),
    );
    let local = ash_state::SqliteThreadStore::open(profile.path().join("state.sqlite3")).unwrap();
    let controller = ash_core::ThreadController::with_store(source.clone());
    for (name, root) in [("known", Some("/recorded/remote/root")), ("unknown", None)] {
        controller
            .create_thread(ash_core::CreateThreadRequest {
                agent_id: ash_protocol::AgentId::new(format!("agent-{name}")).unwrap(),
                origin: ash_protocol::ThreadOrigin::Root,
                agent: None,
                session_id: SessionId::new(name).unwrap(),
                thread_id: ThreadId::new(name).unwrap(),
                title: name.into(),
                execution_target: root
                    .map(|root| SessionExecutionTarget::Local { root: root.into() }),
            })
            .unwrap();
    }
    let attachments = attachment_store::MemoryAttachmentStore::default();
    let mut archive = Vec::new();
    source
        .export_history(
            &local.history_identity().unwrap(),
            &attachments,
            &mut archive,
        )
        .unwrap();
    local
        .import_history("history-host", &attachments, archive.as_slice())
        .unwrap();
    let remote_profile = ash_remote::RemoteProfile::new(
        ash_remote::SshTarget::new(
            ash_remote::SshHost::parse("history-host").unwrap(),
            ash_remote::RemoteDirPath::parse("/another/remote/root").unwrap(),
        ),
        ash_remote::RemoteRuntime::new("/selected/runtime/ash-remote-server").unwrap(),
    );
    ash_remote_profile_store::RemoteConnectionProfileStore::from_profile_root(profile.path())
        .activate(&remote_profile)
        .unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap(),
    );
    let server = registry.server_for(options).unwrap();
    assert!(registry.remote_profiles().unwrap().is_empty());
    assert!(
        registry
            .remote_profile("history-host", "/another/remote/root")
            .is_ok()
    );
    // A cached remote catalog entry cannot take ownership of a local historical identity.
    let stale: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::from([(
        "known".into(),
        RemoteKey::Ssh("wrong-host".into(), "/wrong/root".into()),
    )])));
    assert_eq!(
        selected_execution_target(
            &registry,
            &stale,
            &serde_json::json!({"method":"session/read","params":{"sessionId":"known"}})
        )
        .unwrap(),
        None
    );
    assert_eq!(
        selected_execution_target(
            &registry,
            &stale,
            &serde_json::json!({"method":"session/thread/read","params":{"threadId":"known"}})
        )
        .unwrap(),
        None
    );
    let marker = profile.path().join("must-not-spawn-ssh");
    let (mut client, stream) = crate::server::request_dispatch::tests::Client::pair();
    let launch = RemoteLaunch {
        executable: marker.clone().into_os_string(),
        initialize_timeout: std::time::Duration::from_secs(1),
    };
    let served = thread::spawn(move || {
        let (reader, writer) = ash_app_server_transport::LocalStream::pair(stream).unwrap();
        let result = serve(registry, server, BufReader::new(reader), writer, launch);
        assert!(
            result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(crate::managed::is_peer_disconnect)
        );
    });
    client.initialize();
    client.send(4, "session/list", serde_json::json!({}));
    // Provider discovery can publish notifications while a catalog read is pending.
    let response_for = |client: &mut crate::server::request_dispatch::tests::Client, id: u64| {
        loop {
            let response = client.read();
            if response.get("id").is_none() && response.get("method").is_some() {
                continue;
            }
            assert_eq!(response["id"], id, "{response}");
            break response;
        }
    };
    let catalog = response_for(&mut client, 4);
    assert_eq!(catalog["result"]["sessions"].as_array().unwrap().len(), 2);
    for (id, session) in [(2, "known"), (3, "unknown")] {
        client.send(id, "session/read", serde_json::json!({"sessionId":session}));
        let response = response_for(&mut client, id);
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["session"]["sessionId"], session);
        if session == "known" {
            assert_eq!(
                response["result"]["session"]["executionTarget"],
                serde_json::json!({"type":"ssh","host":"history-host","root":"/recorded/remote/root"})
            );
        }
    }
    client.close();
    served.join().unwrap();
    assert!(!marker.exists());
    assert_eq!(local.list_thread_ids().unwrap().len(), 2);
}

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
            concat!(
                "for expected in ConnectTimeout=30 ServerAliveInterval=15 ServerAliveCountMax=3; do\n",
                "  found=0\n",
                "  for argument; do [ \"$argument\" != \"$expected\" ] || found=1; done\n",
                "  [ \"$found\" = 1 ] || exit 97\n",
                "done\n",
                "IFS= read -r initialize\nprintf '%s' $$ > '{}'\nwhile IFS= read -r request; do :; done\n",
            ),
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
        ProfileAppServerRegistry::open(
            ash_app_server_daemon::ConnectionOptions::new(
                profile.path(),
                None,
                ash_app_server_daemon::GrantSource::HostConfiguration,
                None,
            ),
            ash_app_server_diff::compute,
        )
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
        ProfileAppServerRegistry::open(
            ash_app_server_daemon::ConnectionOptions::new(
                root.path(),
                None,
                ash_app_server_daemon::GrantSource::HostConfiguration,
                None,
            ),
            ash_app_server_diff::compute,
        )
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
    let key = RemoteKey::Ssh("build-host".to_owned(), "/work/first".to_owned());
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
        Some(&RemoteKey::Ssh("build-host".into(), "/work/second".into()))
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
fn provider_catalog_and_thread_directories_keep_container_authority() {
    let index: RemoteSessionIndex = Arc::new(Mutex::new(BTreeMap::new()));
    let key = RemoteKey::Provider {
        provider_id: "ash.dev-containers".into(),
        workspace: std::env::temp_dir().join("source"),
        root: "/workspace".into(),
    };
    let mut result = serde_json::json!({"result": {
        "session": {"sessionId":"container-session","threads":[{"threadId":"container-thread"}],"executionTarget":{"type":"local","root":"/workspace"}},
        "threadProjections": [{"thread":{"threadId":"container-thread"},"directory":{"type":"local","root":"/workspace/branch"}}, {"thread":{"threadId":"no-files"},"directory":null}]
    }});
    annotate_remote_sessions(&mut result, &key, &index);
    assert_eq!(
        result["result"]["session"]["executionTarget"]["type"],
        "provider"
    );
    assert_eq!(
        result["result"]["threadProjections"][0]["directory"]["providerId"],
        "ash.dev-containers"
    );
    assert_eq!(
        result["result"]["threadProjections"][0]["directory"]["root"],
        "/workspace/branch"
    );
    assert!(result["result"]["threadProjections"][1]["directory"].is_null());
    assert_eq!(index.lock().unwrap().get("container-thread"), Some(&key));
}

#[test]
fn preparing_a_runtime_probes_the_real_protocol_and_rejects_incompatible_children() {
    use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
    use ash_app_server_protocol::protocol::initialize::ServerCapabilities;
    let mut capabilities = ServerCapabilities {
        sessions: true,
        threads: true,
        turns: true,
        ..Default::default()
    };
    capabilities.advertise_contracts();
    for (compatible, valid_catalog) in [(true, true), (false, true), (true, false)] {
        let profile = tempfile::tempdir().unwrap();
        let executable = profile.path().join(if cfg!(windows) {
            "runtime.cmd"
        } else {
            "runtime.sh"
        });
        let schema = if compatible {
            ash_app_server_protocol::schema_hash()
        } else {
            format!("sha256:{}", "0".repeat(64))
        };
        let initialize = serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"ash-app-server","version":"test"},"protocolVersion":ProtocolVersion::current(),"schemaHash":schema,"capabilities":capabilities,"slashCommands":[]}});
        let catalog = serde_json::json!({"jsonrpc":"2.0","id":2,"result": if valid_catalog { serde_json::json!({"sessions":[]}) } else { serde_json::json!({}) }});
        let script = if cfg!(windows) {
            format!(
                "@echo off\r\nset /p initialize=\r\necho {initialize}\r\nset /p catalog=\r\necho {catalog}\r\n"
            )
        } else {
            format!(
                "#!/bin/sh\nIFS= read -r initialize\nprintf '%s\\n' '{initialize}'\nIFS= read -r catalog\nprintf '%s\\n' '{catalog}'\n"
            )
        };
        std::fs::write(&executable, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let policy = Arc::new(
            ash_core_plugins::EditorExtensionPolicy::open(profile.path().join("policy.json"))
                .unwrap(),
        );
        let environment = ["PATH", "SystemRoot", "COMSPEC", "TEMP"]
            .into_iter()
            .filter_map(|key| std::env::var_os(key).map(|value| (key.into(), value)))
            .collect();
        let authority = crate::session_runtime_provider::SessionRuntimeProvider::open(
            profile.path(),
            policy,
            Some(
                crate::session_runtime_provider::SessionRuntimeInstallation {
                    executable: executable.clone(),
                    environment,
                },
            ),
            probe_runtime,
        )
        .unwrap();
        let target = SessionExecutionTarget::Provider {
            provider_id: "ash.dev-containers".into(),
            workspace: profile.path().canonicalize().unwrap(),
            root: "/workspace".into(),
        };
        let token = ash_async_utils::CancellationSource::new();
        let result = probe_runtime(authority.clone(), &target, executable, &token.token());
        assert_eq!(result.is_ok(), compatible && valid_catalog, "{result:?}");
        assert!(
            authority.targets().is_empty(),
            "a probe owns no durable admission"
        );
    }
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

#[test]
fn document_read_routes_preserve_nested_gateway_proofs() {
    let request = serde_json::json!({
        "jsonrpc":"2.0", "id":"document-read", "method":"textDocument/read",
        "params":{"path":"/workspace/file.txt", "readAccess":"operation-proof"}
    });
    let inner = tag_host_request(request.to_string(), 0);
    let outer: Value = serde_json::from_str(&tag_host_request(inner, 7)).unwrap();
    let callback = serde_json::json!({"params":outer["params"]});
    let (route, access) = GatewayHandleKind::DocumentRead
        .decode(callback["params"]["readAccess"].as_str().unwrap())
        .unwrap();
    assert_eq!(route, 7);
    let (route, access) = GatewayHandleKind::DocumentRead.decode(access).unwrap();
    assert_eq!(route, 0);
    assert_eq!(access, "operation-proof");
}

#[cfg(unix)]
#[test]
fn document_tools_read_and_edit_through_the_issuing_directory_gateway() {
    run_gateway_file_tools(crate::client_host::TextDocumentMode::Client);
}

#[cfg(unix)]
#[test]
fn file_tools_run_without_an_editor_host() {
    run_gateway_file_tools(crate::client_host::TextDocumentMode::FileSystem);
}

#[cfg(unix)]
fn run_gateway_file_tools(document_mode: crate::client_host::TextDocumentMode) {
    use serde_json::json;
    use std::io::Write;
    use std::time::Duration;
    use tokio::io::AsyncBufReadExt;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    // A scripted provider selects real tools; the client below supplies only the
    // editor callbacks. There is no observer connection or direct tool invocation.
    let model_runtime = tokio::runtime::Runtime::new().unwrap();
    let listener = model_runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let endpoint = listener.local_addr().unwrap();
    let model = model_runtime.spawn(async move {
        for (index, (name, arguments)) in [
            ("read_file", json!({"path":"file.txt","offset":null,"limit":null})),
            ("apply_patch", json!({"patch":"*** Begin Patch\n*** Update File: file.txt\n@@\n-baseline\n+patched\n*** End Patch\n"})),
            ("read_file", json!({"path":"file.txt","offset":null,"limit":null})),
            ("edit", json!({"path":"file.txt","old_string":"patched","new_string":"edited","replace_all":false})),
            ("", Value::Null),
        ].into_iter().enumerate() {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let mut length = 0;
            loop {
                let mut line = String::new();
                socket.read_line(&mut line).await.unwrap();
                if line == "\r\n" { break; }
                if let Some((key, value)) = line.split_once(':') {
                    if key.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
            }
            assert!(length < 1024 * 1024);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["model"], "fixture-model");
            let (delta, finish) = if name.is_empty() {
                (json!({"content":"done"}), "stop")
            } else {
                let tools = request["tools"].as_array().unwrap();
                let (name, arguments) = if tools.iter().any(|tool| tool["function"]["name"] == name) {
                    (name, arguments)
                } else {
                    assert!(tools.iter().any(|tool| tool["function"]["name"] == "exec"), "missing {name}: {:?}", tools.iter().map(|tool| &tool["function"]["name"]).collect::<Vec<_>>());
                    ("exec", json!({"source":format!("const entry = ALL_TOOLS.find(t => t.toolName === {name:?} || t.name === {name:?} || t.name.endsWith('_' + {name:?})); if (!entry) throw new Error('Missing tool'); text(await tools[entry.name]({arguments}));"),"yieldTimeMs":10000,"maxOutputTokens":2000}))
                };
                (json!({"tool_calls":[{"index":0,"id":format!("tool-{index}"),"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]}), "tool_calls")
            };
            let body = format!("data: {}\n\ndata: [DONE]\n\n", json!({"id":format!("response-{index}"),"object":"chat.completion.chunk","model":"fixture-model","choices":[{"index":0,"delta":delta,"finish_reason":finish}]}));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("file.txt"), "baseline\n").unwrap();
    std::fs::write(profile.path().join("config.toml"), format!(
        "schemaVersion = 10\n[connections.custom-documents]\nprovider = \"custom-documents\"\nconnection = \"custom-documents\"\nbaseUrl = \"http://{endpoint}/v1\"\n[connections.custom-documents.custom]\nmodel = \"fixture-model\"\nname = \"Document routing fixture\"\nprotocol = \"chatCompletions\"\ncontextWindow = 272000\norder = 0\n"
    )).unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap(),
    );
    let server = registry.server_for(options).unwrap();
    let (mut client, stream) = crate::server::request_dispatch::tests::Client::pair();
    client
        .writer
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let served = thread::spawn(move || {
        let (reader, writer) = ash_app_server_transport::LocalStream::pair(stream).unwrap();
        let result = serve(
            registry,
            server,
            BufReader::new(reader),
            writer,
            RemoteLaunch::from_environment(),
        );
        assert!(
            result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(crate::managed::is_peer_disconnect)
        );
    });
    let mut next_id = 0;
    let mut snapshots = BTreeMap::<String, PathBuf>::new();
    let mut reads = Vec::new();
    let mut read_errors = Vec::new();
    let mut applied = 0;
    let mut call = |method: &str, params: Value| {
        next_id += 1;
        let id = next_id;
        client.send(id, method, params);
        loop {
            let message = client.read();
            if message["id"] == id {
                break message;
            }
            let mut pending_response = None;
            let response = match message["method"].as_str() {
                Some("textDocument/read") => {
                    next_id += 1;
                    let read_id = next_id;
                    client.send(read_id, "fs/readFile", message["params"].clone());
                    let read = loop {
                        let response = client.read();
                        if response["id"] == read_id {
                            break response;
                        }
                        if response["id"] == id {
                            pending_response = Some(response);
                        }
                    };
                    if read.get("error").is_some() {
                        read_errors.push(read.clone());
                        json!({"kind":"failed","message":read["error"].to_string()})
                    } else {
                        reads.push(message["params"].clone());
                        let snapshot = format!("snapshot-{}", reads.len());
                        snapshots.insert(
                            snapshot.clone(),
                            PathBuf::from(message["params"]["path"].as_str().unwrap()),
                        );
                        json!({"kind":"document","snapshot":snapshot,"text":read["result"]["content"]})
                    }
                }
                Some("textDocument/apply") => {
                    for change in message["params"]["changes"].as_array().unwrap() {
                        assert_eq!(change["kind"], "update");
                        let path = &snapshots[change["snapshot"].as_str().unwrap()];
                        std::fs::write(path, change["text"].as_str().unwrap()).unwrap();
                        applied += 1;
                    }
                    json!({"kind":"applied"})
                }
                Some("textDocument/release") => Value::Null,
                Some("textDocument/list") => json!({"kind":"documents","documents":[]}),
                _ => continue,
            };
            writeln!(
                client.writer,
                "{}",
                json!({"jsonrpc":"2.0","id":message["id"],"result":response})
            )
            .unwrap();
            if let Some(response) = pending_response {
                break response;
            }
        }
    };
    let capabilities = match document_mode {
        crate::client_host::TextDocumentMode::Client => {
            json!({"textDocuments":{"version":2},"directoryGrantsHost":{"version":1}})
        }
        crate::client_host::TextDocumentMode::FileSystem => {
            json!({"directoryGrantsHost":{"version":1}})
        }
    };
    let initialized = call(
        "initialize",
        json!({"clientInfo":{"name":"document-gateway-test","version":"1"},"capabilities":capabilities}),
    );
    assert!(initialized.get("result").is_some(), "{initialized}");
    let configured = call(
        "config/update",
        json!({"commandId":"document-model","expectedRevision":0,"model":{"provider":"custom-documents","model":"fixture-model"},"execution":{"approvalMode":"bypassPermissions","commandFileAccess":"directoryWrite","commandNetworkAccess":"denied"}}),
    );
    assert!(configured.get("result").is_some(), "{configured}");
    for access in [
        "unqualified-proof",
        "gateway-document:invalid:proof",
        "gateway-document:999:proof",
        "gateway-document:0:proof",
    ] {
        let denied = call(
            "fs/readFile",
            json!({
                "path":source.path().join("file.txt"), "readAccess":access
            }),
        );
        assert_eq!(
            denied["error"]["data"]["kind"], "FileSystemOperationFailed",
            "{denied}"
        );
    }
    let granted = call(
        "config/directoryGrants/set",
        json!({
            "commandId":"document-grant", "expectedRevision":configured["result"]["revision"],
            "path":source.path(), "permissions":[
                "readFiles", "writeFiles", "executeCommands", "browseFiles", "searchFiles",
                "loadInstructions", "inspectRepository", "mutateRepository"
            ]
        }),
    );
    assert!(granted.get("result").is_some(), "{granted}");
    let created = call(
        "session/create",
        json!({"commandId":"document-session","title":"Documents","agent":{"type":"default"},"executionTarget":{"type":"local","root":source.path()}}),
    );
    assert!(created.get("result").is_some(), "{created}");
    let session = created["result"]["session"]["sessionId"].clone();
    let thread = created["result"]["session"]["threads"][0]["threadId"].clone();
    let identity = json!({"sessionId":session,"threadId":thread});
    let initial = call("session/thread/read", identity.clone());
    let root = PathBuf::from(initial["result"]["directory"]["root"].as_str().unwrap());
    let started = call(
        "session/request",
        json!({"commandId":"document-turn","sessionId":session,"request":{"type":"startTurn","threadId":thread,"expectedSequence":initial["result"]["thread"]["sequence"],"input":[{"type":"text","text":"Read file.txt, patch baseline to patched, then edit patched to edited."}]}}),
    );
    assert!(started.get("result").is_some(), "{started}");
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let final_thread = loop {
        let read = call("session/thread/read", identity.clone());
        let turn = &read["result"]["thread"]["turns"][0];
        if matches!(
            turn["status"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            break read;
        }
        assert!(std::time::Instant::now() < deadline, "{read}");
        thread::sleep(Duration::from_millis(10));
    };
    drop(call);
    for params in &reads {
        next_id += 1;
        client.send(next_id, "fs/readFile", params.clone());
        loop {
            let response = client.read();
            if response["id"] == next_id {
                assert_eq!(
                    response["error"]["data"]["kind"], "FileSystemOperationFailed",
                    "{response}"
                );
                break;
            }
        }
    }
    drop(client);
    served.join().unwrap();
    model_runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), model)
            .await
            .unwrap()
            .unwrap();
    });
    assert!(
        read_errors.is_empty(),
        "document read callbacks reached the wrong runtime: {read_errors:?}"
    );
    match document_mode {
        crate::client_host::TextDocumentMode::Client => {
            assert!(!reads.is_empty(), "{final_thread}");
            assert_eq!(applied, 2, "{final_thread}");
        }
        crate::client_host::TextDocumentMode::FileSystem => {
            assert!(reads.is_empty(), "unexpected editor reads: {reads:?}");
            assert_eq!(applied, 0, "unexpected editor commits: {final_thread}");
        }
    }
    assert_eq!(
        std::fs::read_to_string(root.join("file.txt")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        std::fs::read_to_string(source.path().join("file.txt")).unwrap(),
        "baseline\n"
    );
    let results = final_thread["result"]["thread"]["turns"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "toolResult")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 4, "{final_thread}");
    assert!(
        results.iter().all(|result| result["isError"] == false),
        "{results:?}"
    );
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
fn task_ssh_fixture(
    script: impl FnOnce(&std::path::Path) -> String,
) -> (tempfile::TempDir, RemoteProfile, RemoteLaunch) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("ssh");
    std::fs::write(
        &executable,
        format!("#!/bin/sh\n{}", script(directory.path())),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let profile = RemoteProfile::new(
        ash_remote::SshTarget::new(
            ash_remote::SshHost::parse("mac").unwrap(),
            ash_remote::RemoteDirPath::parse("/workspace").unwrap(),
        ),
        ash_remote::RemoteRuntime::new("/runtime/ash-remote-server").unwrap(),
    );
    (
        directory,
        profile,
        RemoteLaunch {
            executable: executable.into_os_string(),
            initialize_timeout: std::time::Duration::from_secs(2),
        },
    )
}

#[cfg(unix)]
#[test]
fn task_delivery_ssh_checks_its_contract_and_pairs_the_task_response() {
    let mut initialized: Value = serde_json::from_str(&remote_initialize_result()).unwrap();
    initialized["result"]["capabilities"]["contracts"]["taskDelivery"] =
        serde_json::json!({"version":1});
    let (directory, profile, launch) = task_ssh_fixture(|root| {
        format!(
            "IFS= read -r initialize\nprintf '%s\\n' '{}'\nIFS= read -r request\nprintf '%s' \"$request\" > '{}'\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"head\":\"{}\"}}}}'\nwhile IFS= read -r request; do :; done\n",
            initialized.to_string().replace('\'', "'\"'\"'"),
            root.join("request").display(),
            "a".repeat(40)
        )
    });
    let value = task_request_with_launch(
        profile,
        ash_app_server_protocol::protocol::registry::ClientMethod::TaskSnapshotInfo,
        serde_json::json!({}),
        &ash_async_utils::CancellationSource::new().token(),
        launch,
    )
    .unwrap();
    assert_eq!(value, serde_json::json!({"head":"a".repeat(40)}));
    let request: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("request")).unwrap()).unwrap();
    assert_eq!(request["method"], "task/snapshotInfo");
}

#[cfg(unix)]
#[test]
fn task_delivery_ssh_rejects_an_old_backend_before_sending_a_task() {
    let initialized = remote_initialize_result();
    let (directory, profile, launch) = task_ssh_fixture(|root| {
        format!(
            "IFS= read -r initialize\nprintf '%s\\n' '{}'\nif IFS= read -r request; then printf '%s' \"$request\" > '{}'; fi\n",
            initialized.replace('\'', "'\"'\"'"),
            root.join("request").display()
        )
    });
    let error = task_request_with_launch(
        profile,
        ash_app_server_protocol::protocol::registry::ClientMethod::TaskReceive,
        serde_json::json!({}),
        &ash_async_utils::CancellationSource::new().token(),
        launch,
    )
    .unwrap_err();
    assert!(error.contains("taskDelivery"), "{error}");
    assert!(!directory.path().join("request").exists());
}

#[cfg(unix)]
#[test]
fn task_delivery_ssh_cancellation_closes_a_stalled_handshake() {
    let (_directory, profile, launch) = task_ssh_fixture(|_| {
        "IFS= read -r initialize\nwhile IFS= read -r request; do :; done\n".into()
    });
    let cancellation = ash_async_utils::CancellationSource::new();
    let token = cancellation.token();
    let started = std::time::Instant::now();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            cancellation.cancel();
        });
        assert!(
            task_request_with_launch(
                profile,
                ash_app_server_protocol::protocol::registry::ClientMethod::TaskSnapshotInfo,
                serde_json::json!({}),
                &token,
                launch
            )
            .is_err()
        );
    });
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
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
        RemoteKey::Ssh("host".into(), "/workspace".into()),
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

#[cfg(unix)]
#[test]
fn directory_resources_remain_on_their_creating_gateway_connection() {
    use base64::Engine;
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("bytes.bin"), b"directory resource").unwrap();
    std::fs::write(root.path().join("profile.bin"), b"profile resource").unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap(),
    );
    let server = registry.server_for(options).unwrap();
    let start = || {
        let registry = Arc::clone(&registry);
        let server = Arc::clone(&server);
        let (mut client, stream) = crate::server::request_dispatch::tests::Client::pair();
        let served = thread::spawn(move || {
            let (reader, writer) = ash_app_server_transport::LocalStream::pair(stream).unwrap();
            let result = serve(
                registry,
                server,
                BufReader::new(reader),
                writer,
                RemoteLaunch::from_environment(),
            );
            assert!(
                result.is_ok()
                    || result
                        .as_ref()
                        .is_err_and(crate::managed::is_peer_disconnect)
            );
        });
        client.send(1, "initialize", serde_json::json!({"clientInfo":{"name":"resource-gateway-test","version":"1"},"capabilities":{"directoryGrantsHost":{"version":1}}}));
        assert!(client.read()["result"].is_object());
        (client, served)
    };
    let call = |client: &mut crate::server::request_dispatch::tests::Client, id, method, params| {
        client.send(id, method, params);
        loop {
            let message = client.read();
            if message["id"] == id {
                break message;
            }
        }
    };
    let (mut owner, served) = start();
    let configured = call(
        &mut owner,
        20,
        "env/dirs/set",
        serde_json::json!({"dirs":[{"id":"profile-files","path":root.path(),"grant":{"type":"host","permissions":["readFiles"]}}]}),
    );
    assert!(configured.get("result").is_some(), "{configured}");
    let profile_opened = call(
        &mut owner,
        21,
        "fs/readBinaryFile",
        serde_json::json!({"dirId":"profile-files","path":"profile.bin"}),
    );
    assert!(profile_opened.get("result").is_some(), "{profile_opened}");
    let profile_resource = profile_opened["result"]["resource"]["resourceId"].clone();
    assert!(
        profile_resource
            .as_str()
            .unwrap()
            .starts_with("gateway-resource:0:")
    );
    let created = call(
        &mut owner,
        2,
        "session/create",
        serde_json::json!({
            "commandId":"resource-session", "title":"Resource owner",
            "executionTarget":{"type":"local", "root":root.path()}
        }),
    );
    assert!(created.get("result").is_some(), "{created}");
    let session_id = created["result"]["session"]["sessionId"].clone();
    let granted = call(
        &mut owner,
        8,
        "session/dirs/add",
        serde_json::json!({"sessionId":session_id,"path":root.path(),"permissions":["readFiles"]}),
    );
    assert!(granted.get("result").is_some(), "{granted}");
    let read_params = serde_json::json!({"sessionDirectory":{"sessionId":session_id,"path":root.path()},"path":"bytes.bin"});
    let opened = call(&mut owner, 3, "fs/readBinaryFile", read_params.clone());
    assert!(opened.get("result").is_some(), "{opened}");
    let resource = opened["result"]["resource"]["resourceId"].clone();
    let metadata = call(
        &mut owner,
        4,
        "resource/metadata",
        serde_json::json!({"resourceId":resource}),
    );
    assert_eq!(metadata["result"], opened["result"]["resource"]);
    let read = call(
        &mut owner,
        5,
        "resource/read",
        serde_json::json!({"resourceId":resource,"offset":0,"maxBytes":262144}),
    );
    assert_eq!(read["result"]["resourceId"], resource);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(read["result"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"directory resource"
    );
    // A bare backend ID is never an alternate gateway entrypoint, with or without
    // the removed Session selector. Rejected release must leave the resource live.
    let legacy_id = resource.as_str().unwrap().splitn(3, ':').nth(2).unwrap();
    let mut next_denied_id = 30;
    for method in ["resource/metadata", "resource/read", "resource/release"] {
        let mut params = serde_json::json!({"resourceId":legacy_id});
        if method == "resource/read" {
            params["offset"] = serde_json::json!(0);
            params["maxBytes"] = serde_json::json!(1);
        }
        for selector in [None, Some(session_id.clone())] {
            let mut params = params.clone();
            if let Some(selector) = selector {
                params["sessionId"] = selector;
            }
            let denied = call(&mut owner, next_denied_id, method, params);
            next_denied_id += 1;
            assert_eq!(denied["error"]["message"], "ResourceNotOwner", "{denied}");
        }
        let mut params = serde_json::json!({"resourceId":profile_resource,"sessionId":session_id});
        if method == "resource/read" {
            params["offset"] = serde_json::json!(0);
            params["maxBytes"] = serde_json::json!(1);
        }
        let denied = call(&mut owner, next_denied_id, method, params);
        next_denied_id += 1;
        assert_eq!(denied["error"]["message"], "InvalidParams", "{denied}");
    }
    // Profile operations use their opening handle, including release, without a
    // Session selector or a second route lookup.
    for (id, method) in (22..).zip(["resource/metadata", "resource/read", "resource/release"]) {
        let mut params = serde_json::json!({"resourceId":profile_resource});
        if method == "resource/read" {
            params["offset"] = serde_json::json!(0);
            params["maxBytes"] = serde_json::json!(1);
        }
        let response = call(&mut owner, id, method, params);
        assert!(response.get("result").is_some(), "{method}: {response}");
        if method != "resource/release" {
            assert_eq!(response["result"]["resourceId"], profile_resource);
        }
        if method == "resource/read" {
            assert_eq!(response["result"]["dataBase64"], "cA==");
        }
    }
    let still_owned = call(
        &mut owner,
        25,
        "resource/read",
        serde_json::json!({"resourceId":resource,"offset":0,"maxBytes":1}),
    );
    assert_eq!(still_owned["result"]["dataBase64"], "ZA==", "{still_owned}");
    let (mut other, other_served) = start();
    // Open the same directory route on a second client; the route tag grants no ownership.
    let second = call(&mut other, 2, "fs/readBinaryFile", read_params);
    assert!(second.get("result").is_some(), "{second}");
    for (id, method, params) in [
        (
            3,
            "resource/metadata",
            serde_json::json!({"resourceId":resource}),
        ),
        (
            4,
            "resource/read",
            serde_json::json!({"resourceId":resource,"offset":0,"maxBytes":1}),
        ),
        (
            5,
            "resource/release",
            serde_json::json!({"resourceId":resource}),
        ),
    ] {
        let denied = call(&mut other, id, method, params);
        assert_eq!(denied["error"]["message"], "ResourceNotOwner", "{denied}");
    }
    let released = call(
        &mut owner,
        6,
        "resource/release",
        serde_json::json!({"resourceId":resource}),
    );
    assert!(released.get("result").is_some(), "{released}");
    let missing = call(
        &mut owner,
        7,
        "resource/metadata",
        serde_json::json!({"resourceId":resource}),
    );
    assert!(missing.get("error").is_some());
    other.close();
    owner.close();
    other_served.join().unwrap();
    served.join().unwrap();
}

#[cfg(unix)]
#[test]
fn ssh_resources_route_back_to_the_live_connection_without_a_session_parameter() {
    let initialize = remote_initialize_result();
    let catalog = serde_json::json!({"jsonrpc":"2.0","id":catalog_request_id(1),"result":{"sessions":[{"sessionId":"remote-session","threads":[],"executionTarget":{"type":"local","root":"/workspace"}}]}}).to_string();
    let mut gateway = gateway_with_ssh(std::time::Duration::from_secs(10), |marker| {
        format!(
            "IFS= read -r initialize\nprintf '%s\\n' '{}'\nIFS= read -r catalog\nprintf '%s\\n' '{}'\nIFS= read -r open\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{{\"resource\":{{\"resourceId\":\"remote-bytes\",\"mimeType\":\"text/plain\",\"size\":1,\"sha256\":\"digest\"}}}}}}'\nIFS= read -r read\nprintf '%s' \"$read\" > '{}'\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{{\"resourceId\":\"remote-bytes\",\"offset\":0,\"dataBase64\":\"eA==\",\"decodedLength\":1,\"eof\":true}}}}'\nwhile IFS= read -r request; do :; done\n",
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
    gateway.client.send(
        3,
        "skill/resource/open",
        serde_json::json!({"sessionId":"remote-session"}),
    );
    let opened = gateway.client.read();
    let resource = opened["result"]["resource"]["resourceId"].clone();
    assert_eq!(resource, "gateway-resource:1:remote-bytes");
    gateway.client.send(
        4,
        "resource/read",
        serde_json::json!({"resourceId":resource,"offset":0,"maxBytes":1}),
    );
    let read = gateway.client.read();
    assert_eq!(read["result"]["resourceId"], resource);
    assert_eq!(read["result"]["dataBase64"], "eA==");
    let forwarded: Value = serde_json::from_str(&wait_for_ssh(&gateway.marker)).unwrap();
    assert_eq!(forwarded["params"]["resourceId"], "remote-bytes");
    for (id, resource) in (5..).zip([
        "gateway-resource:999:remote-bytes",
        "gateway-resource:invalid:remote-bytes",
        "gateway-resource:0:",
    ]) {
        gateway.client.send(
            id,
            "resource/metadata",
            serde_json::json!({"sessionId":"remote-session","resourceId":resource}),
        );
        assert_eq!(
            gateway.client.read()["error"]["message"],
            "ResourceNotOwner"
        );
    }
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[test]
fn ssh_document_callbacks_preserve_nested_owners_and_fail_after_route_close() {
    use std::io::Write;
    let initialize = remote_initialize_result();
    let catalog =
        serde_json::json!({"jsonrpc":"2.0","id":catalog_request_id(1),"result":{"sessions":[]}});
    let callback = serde_json::json!({
        "jsonrpc":"2.0", "id":"browser-host:gateway:4:read", "method":"textDocument/read",
        "params":{"path":"/workspace/file.txt","readAccess":"gateway-document:4:proof"}
    });
    let result = serde_json::json!({"jsonrpc":"2.0","id":3,"result":{"content":"remote content","revision":"revision"}});
    let mut gateway = gateway_with_ssh(std::time::Duration::from_secs(10), |marker| {
        format!(
            r#"IFS= read -r initialize
printf '%s\n' '{initialize}'
IFS= read -r catalog
printf '%s\n' '{catalog}' '{callback}'
IFS= read -r request
printf '%s\n' "$request" > '{marker}'
printf '%s\n' '{result}'
IFS= read -r reply
printf '%s\n' "$reply" >> '{marker}'
"#,
            initialize = initialize.replace('\'', "'\"'\"'"),
            marker = marker.display(),
        )
    });
    gateway
        .client
        .send(2, "session/list", serde_json::json!({}));
    // The Profile catalog and remote notifications can finish in either order.
    let first = gateway.client.read();
    let second = gateway.client.read();
    let (catalog, forwarded_callback) = if first["id"] == 2 {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(catalog["id"], 2);
    assert!(catalog["result"]["sessions"].is_array());
    assert_eq!(forwarded_callback["method"], "textDocument/read");
    assert_eq!(
        forwarded_callback["params"]["readAccess"],
        "gateway-document:1:gateway-document:4:proof"
    );
    gateway
        .client
        .send(3, "fs/readFile", forwarded_callback["params"].clone());
    assert_eq!(gateway.client.read(), result);
    let forwarded: Value = serde_json::from_str(&wait_for_ssh(&gateway.marker)).unwrap();
    assert_eq!(
        forwarded["params"]["readAccess"],
        "gateway-document:4:proof"
    );
    writeln!(
        gateway.client.writer,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":forwarded_callback["id"],"result":{"kind":"notFound"}})
    )
    .unwrap();
    gateway
        .client
        .send(4, "fs/readFile", forwarded_callback["params"].clone());
    let stale = gateway.client.read();
    assert_eq!(stale["id"], 4);
    assert!(stale.get("error").is_some(), "{stale}");
    let messages = std::fs::read_to_string(&gateway.marker).unwrap();
    let reply: Value = serde_json::from_str(messages.lines().nth(1).unwrap()).unwrap();
    assert_eq!(reply["id"], callback["id"]);
    gateway.close();
    gateway
        .completed
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap()
        .unwrap();
}

#[cfg(unix)]
#[test]
fn voice_media_stays_in_profile_while_the_gateway_resolves_the_original_directory_thread() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap(),
    );
    let server = registry.server_for(options).unwrap();
    let (mut client, stream) = crate::server::request_dispatch::tests::Client::pair();
    let served = thread::spawn(move || {
        let (reader, writer) = ash_app_server_transport::LocalStream::pair(stream).unwrap();
        let result = serve(
            registry,
            server,
            BufReader::new(reader),
            writer,
            RemoteLaunch::from_environment(),
        );
        assert!(
            result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(crate::managed::is_peer_disconnect)
        );
    });
    let call = |client: &mut crate::server::request_dispatch::tests::Client, id, method, params| {
        client.send(id, method, params);
        loop {
            let message = client.read();
            if message["id"] == id {
                break message;
            }
        }
    };
    let initialized = call(
        &mut client,
        1,
        "initialize",
        serde_json::json!({"clientInfo":{"name":"voice-directory-test","version":"1"},"capabilities":{"directoryGrantsHost":{"version":1}}}),
    );
    assert!(initialized["result"].is_object());
    let created = call(
        &mut client,
        2,
        "session/create",
        serde_json::json!({"commandId":"voice-directory","title":"Voice source","executionTarget":{"type":"local","root":root.path()}}),
    );
    assert!(created.get("result").is_some(), "{created}");
    let session_id = created["result"]["session"]["sessionId"].clone();
    let thread_id = created["result"]["session"]["threads"][0]["threadId"].clone();
    let request = serde_json::json!({"resourceId":"media","operationId":"start","deviceId":"device","sessionId":session_id,"threadId":thread_id,"connectionId":"missing-voice-provider","locale":"en","taskLabels":{"queued":"queued","running":"running","waiting":"waiting","completed":"completed","failed":"failed","stopped":"stopped","rejected":"rejected"}});
    let result = call(&mut client, 3, "voice/start", request);
    assert_eq!(result["error"]["code"], -32000, "{result}");
    assert!(
        result
            .to_string()
            .contains("missing-voice-provider' is not registered"),
        "the actual directory Core must be read before provider admission: {result}"
    );
    drop(client);
    served.join().unwrap();
}

#[cfg(unix)]
#[test]
#[ignore = "requires pinned local Call/LiveKit executables and the explicit AudioHost IPC fixture"]
fn voice_gateway_real_room_records_directory_speech_and_stops_profile_media() {
    use ash_protocol::CommandId;
    use ash_protocol::ModelConnectionId;
    use ash_secrets::SecretStore;
    use futures::SinkExt;
    use futures::StreamExt;
    use std::time::Duration;
    use std::time::Instant;
    use tokio_tungstenite::tungstenite::Message;
    for variable in [
        "ASH_LIVEKIT_SERVER_PATH",
        "ASH_COLLABORATION_SERVER_PATH",
        "ASH_VOICE_HOST_PATH",
    ] {
        assert!(std::env::var_os(variable).is_some(), "missing {variable}");
    }
    let model_runtime = tokio::runtime::Runtime::new().unwrap();
    let listener = model_runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let model = model_runtime.spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let started: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        let selected = started["session"]["model"].clone();
        socket.send(Message::Text(serde_json::json!({"type":"session.started","session":{"id":"gateway-live","model":selected}}).to_string().into())).await.unwrap();
        let mut heard = false;
        while let Some(message) = socket.next().await {
            let Ok(message) = message else { break }; if message.is_close() { break; }
            let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            match value["type"].as_str().unwrap() {
                "session.input_audio.append" if !heard => {
                    heard = true;
                    socket.send(Message::Text(serde_json::json!({"type":"session.input_transcript.delta","delta":"directory speech","start_ms":0,"end_ms":100}).to_string().into())).await.unwrap();
                }
                "session.close" => {
                    socket.send(Message::Text(serde_json::json!({"type":"session.closed","session":{"id":"gateway-live"},"reason":"client","usage":{"seconds":0.5}}).to_string().into())).await.unwrap();
                    break;
                }
                _ => {}
            }
        }
    });
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(
        ash_config::ConfigStore::open(profile.path().join("voice-config.sqlite3")).unwrap(),
    );
    let mut config = model_provider_info::ModelProviderConfig::for_connection(
        ModelConnectionId::new("openai").unwrap(),
    );
    config.base_url = Some(base_url);
    store
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("voice-config").unwrap(),
            expected_revision: ash_config::ConfigRevision::new(0),
            command: ash_config::UserConfigCommand::ConfigureConnection {
                connection: config.connection.clone(),
                config: config.clone(),
            },
        })
        .unwrap();
    let secrets = Arc::new(ash_secrets::MemorySecretStore::default());
    secrets
        .store(
            &ash_model_provider::provider_api_key_secret_key(&config.connection),
            &ash_secrets::SecretValue::new(b"fixture-key".to_vec()),
        )
        .unwrap();
    let provider = Arc::new(ash_model_provider::ModelProviderRuntime::with_secrets(
        model_provider_info::ProviderConfigRegistry::builtin(),
        secrets,
    ));
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry =
        Arc::new(ProfileAppServerRegistry::open(options, ash_app_server_diff::compute).unwrap());
    let server = Arc::new(
        crate::tests::server()
            .with_config_store(store)
            .with_home(Arc::new(ash_home::AshHome::new(
                ash_utils_absolute_path::AbsolutePathBuf::try_from(profile.path()).unwrap(),
            )))
            .with_provider_runtime(provider),
    );
    let (mut client, stream) = crate::server::request_dispatch::tests::Client::pair();
    let served = thread::spawn(move || {
        let (reader, writer) = ash_app_server_transport::LocalStream::pair(stream).unwrap();
        let result = serve(
            registry,
            server,
            BufReader::new(reader),
            writer,
            RemoteLaunch::from_environment(),
        );
        assert!(
            result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(crate::managed::is_peer_disconnect)
        );
    });
    let call = |client: &mut crate::server::request_dispatch::tests::Client, id, method, params| {
        client.send(id, method, params);
        loop {
            let message = client.read();
            if message["id"] == id {
                break message;
            }
        }
    };
    assert!(call(&mut client, 1, "initialize", serde_json::json!({"clientInfo":{"name":"voice-real-gateway","version":"1"},"capabilities":{"directoryGrantsHost":{"version":1}}}))["result"].is_object());
    let created = call(
        &mut client,
        2,
        "session/create",
        serde_json::json!({"commandId":"voice-directory","title":"Directory voice","executionTarget":{"type":"local","root":root.path()}}),
    );
    assert!(created.get("result").is_some(), "{created}");
    let session_id = created["result"]["session"]["sessionId"].clone();
    let thread_id = created["result"]["session"]["threads"][0]["threadId"].clone();
    let start = call(
        &mut client,
        3,
        "voice/start",
        serde_json::json!({"resourceId":"media","operationId":"start","deviceId":"device","sessionId":session_id,"threadId":thread_id,"connectionId":"openai","locale":"en","taskLabels":{"queued":"queued","running":"running","waiting":"waiting","completed":"completed","failed":"failed","stopped":"stopped","rejected":"rejected"}}),
    );
    assert_eq!(start["result"]["state"], "connected", "{start}");
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut id = 4;
    loop {
        let read = call(
            &mut client,
            id,
            "session/thread/read",
            serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
        );
        assert!(read.get("result").is_some(), "{read}");
        assert_eq!(read["result"]["thread"]["turns"], serde_json::json!([]));
        if read["result"]["transcript"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| {
                entry["type"] == "voiceTranscript"
                    && entry["transcript"]["text"] == "directory speech"
            })
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "speech did not enter the original directory journal: {read}"
        );
        id += 1;
        thread::sleep(Duration::from_millis(20));
    }
    let stop = call(
        &mut client,
        id + 1,
        "voice/stop",
        serde_json::json!({"resourceId":"media","mediaEpoch":start["result"]["mediaEpoch"],"operationId":"stop"}),
    );
    assert_eq!(stop["result"]["state"], "ended", "{stop}");
    assert_eq!(stop["result"]["usageMilliseconds"], 500);
    model_runtime.block_on(model).unwrap();
    drop(client);
    served.join().unwrap();
}

#[cfg(unix)]
#[test]
fn ide_attachment_follows_one_gateway_connection_across_directory_routes() {
    use std::io::Write;
    let profile = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir_in(workspace.path()).unwrap();
    let second = tempfile::tempdir_in(workspace.path()).unwrap();
    let options = ash_app_server_daemon::ConnectionOptions::new(
        profile.path(),
        None,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        None,
    );
    let registry = Arc::new(
        ProfileAppServerRegistry::open(options.clone(), ash_app_server_diff::compute).unwrap(),
    );
    let server = registry.server_for(options).unwrap();
    let (mut client, stream) = crate::server::request_dispatch::tests::Client::pair();
    let served = thread::spawn(move || {
        let (reader, writer) = ash_app_server_transport::LocalStream::pair(stream).unwrap();
        let result = serve(
            registry,
            server,
            BufReader::new(reader),
            writer,
            RemoteLaunch::from_environment(),
        );
        assert!(
            result.is_ok()
                || result
                    .as_ref()
                    .is_err_and(crate::managed::is_peer_disconnect)
        );
    });
    client.initialize();
    let mut context_calls = 0;
    let mut handoffs = Vec::new();
    let mut call = |id, method, params| {
        client.send(id, method, params);
        loop {
            let message = client.read();
            if message["method"] == "ide/hostRequest" {
                let result = match message["params"]["type"].as_str().unwrap() {
                    "context" => {
                        context_calls += 1;
                        serde_json::json!({"type":"context", "context":{"activeFile":null,"openTabs":[],"dirtyFiles":[]}})
                    }
                    "openConversation" => {
                        handoffs.push(message["params"].clone());
                        serde_json::json!({"type":"opened"})
                    }
                    other => panic!("unexpected IDE host request: {other}"),
                };
                writeln!(
                    client.writer,
                    "{}",
                    serde_json::json!({"jsonrpc":"2.0", "id":message["id"], "result":result})
                )
                .unwrap();
            } else if message["id"] == id {
                assert!(message.get("error").is_none(), "{message}");
                break message;
            }
        }
    };
    let key = "01234567890123456789012345678901";
    let registered = call(
        2,
        "ide/request",
        serde_json::json!({
            "type":"register", "title":"Origin window", "roots":[workspace.path()], "windowKey":key
        }),
    );
    let window_id = registered["result"]["window"]["id"].clone();
    call(
        3,
        "ide/request",
        serde_json::json!({"type":"attach","windowKey":key}),
    );
    let mut sessions = Vec::new();
    for (id, root) in [(4, first.path()), (5, second.path())] {
        let created = call(
            id,
            "session/create",
            serde_json::json!({
                "commandId":format!("gateway-ide-{id}"), "title":"Directory session",
                "executionTarget":{"type":"local","root":root}
            }),
        );
        sessions.push((
            created["result"]["session"]["sessionId"].clone(),
            created["result"]["session"]["threads"][0]["threadId"].clone(),
        ));
    }
    for (index, (session, thread)) in sessions.iter().enumerate() {
        let result = call(
            6 + index as u64,
            "ide/request",
            serde_json::json!({
                "type":"context", "sessionId":session, "threadId":thread
            }),
        );
        assert_eq!(result["result"]["window"]["id"], window_id);
        assert!(result["result"]["context"].is_object());
    }
    call(8, "ide/request", serde_json::json!({"type":"disconnect"}));
    for (index, (session, thread)) in sessions.iter().enumerate() {
        let result = call(
            9 + index as u64,
            "ide/request",
            serde_json::json!({
                "type":"context", "sessionId":session, "threadId":thread
            }),
        );
        assert!(result["result"]["window"].is_null());
        assert!(result["result"]["context"].is_null());
    }
    let (session, thread) = &sessions[0];
    let opened = call(
        13,
        "ide/request",
        serde_json::json!({
            "type":"openConversation", "sessionId":session, "threadId":thread
        }),
    );
    assert_eq!(opened["result"]["type"], "conversationOpened");
    // Reattachment updates both peers that were already initialized, without replaying selection.
    call(
        11,
        "ide/request",
        serde_json::json!({"type":"attach","windowKey":key}),
    );
    let (session, thread) = &sessions[0];
    let result = call(
        12,
        "ide/request",
        serde_json::json!({
            "type":"context", "sessionId":session, "threadId":thread
        }),
    );
    assert_eq!(result["result"]["window"]["id"], window_id);
    assert_eq!(context_calls, 3);
    assert_eq!(
        handoffs,
        vec![serde_json::json!({
            "type":"openConversation", "sessionId":sessions[0].0, "threadId":sessions[0].1
        })]
    );
    client.close();
    served.join().unwrap();
}
