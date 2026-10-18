use super::*;
use ash_async_utils::CancellationSource;
use ash_install_context::InstallContext;

#[test]
fn exited_server_returns_an_error_instead_of_using_its_stale_index() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let cancellation = CancellationSource::new();
    let server = Server::start(
        &Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &cancellation.token(),
    )
    .unwrap();
    {
        let mut child = server.child.lock().unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
    }
    let error = server
        .rpc(
            "status",
            Value::Null,
            &cancellation.token(),
            Instant::now() + TIMEOUT,
        )
        .unwrap_err();
    assert!(error.to_string().contains("server exited"));
}

#[cfg(unix)]
#[test]
fn cancellation_of_an_active_scan_reaps_its_child() {
    let temporary = tempfile::tempdir().unwrap();
    let pid_file = temporary.path().join("pid");
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("echo $$ > \"$1\"; exec sleep 60")
        .arg("scan-test")
        .arg(&pid_file);
    let cancellation = CancellationSource::new();
    thread::scope(|scope| {
        let worker = scope.spawn(|| {
            capture(
                command,
                &cancellation.token(),
                Instant::now() + TIMEOUT,
                101,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        cancellation.cancel();
        let result = worker.join().unwrap();
        assert!(matches!(result, Err(Error::Cancelled(_))));
    });
    let pid = std::fs::read_to_string(pid_file).unwrap();
    assert!(
        !Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn normal_host_exit_reaps_servers_even_when_sessions_are_retained() {
    const CHILD_INDEX: &str = "ASH_TGREP_TEST_EXIT_INDEX";
    if let Some(index) = std::env::var_os(CHILD_INDEX) {
        let index = PathBuf::from(index);
        let server = Server::start(
            &Executable::resolve(&InstallContext::current()).unwrap(),
            &index.join("root"),
            &index.join("index"),
            &CancellationSource::new().token(),
        )
        .unwrap();
        std::fs::write(index.join("address"), server.address.to_string()).unwrap();
        // Mirrors managed hosts that exit without dropping all background runtime references.
        std::mem::forget(server);
        std::process::exit(0);
    }
    let temporary = tempfile::tempdir().unwrap();
    std::fs::create_dir(temporary.path().join("root")).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "process::tests::normal_host_exit_reaps_servers_even_when_sessions_are_retained",
        ])
        .env(CHILD_INDEX, temporary.path())
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let address = std::fs::read_to_string(temporary.path().join("address")).unwrap();
    // EOF supervision is asynchronous; the server must observe the pipe closure and exit.
    let deadline = Instant::now() + Duration::from_secs(5);
    while TcpStream::connect(&address).is_ok() {
        assert!(Instant::now() < deadline, "server survived its host's exit");
        thread::sleep(POLL);
    }
}

#[test]
fn shared_rpc_validates_response_instances_ids_and_null_id_errors() {
    use std::net::TcpListener;
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let token = CancellationSource::new().token();
    let mut server = Server::start(
        &Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    server.protocol = Protocol::Shared(Discovery {
        pid: 0,
        port: 1,
        protocol: 1,
        instance: "current".into(),
        repository: "repository".into(),
        storage: index.path().into(),
    });
    for (response, expected) in [
        (
            json!({"jsonrpc":"2.0","id":1,"result":{"protocol":1,"instance":"current","repository":"repository"}}),
            None,
        ),
        (
            json!({"jsonrpc":"2.0","id":1,"result":{"protocol":1,"instance":"old","repository":"repository"}}),
            Some("stale or incompatible"),
        ),
        (
            json!({"jsonrpc":"2.0","id":2,"result":{"protocol":1,"instance":"current","repository":"repository"}}),
            Some("invalid tgrep response identity"),
        ),
        (
            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"queue full"}}),
            Some("queue full"),
        ),
        (
            json!({"jsonrpc":"2.0","id":null,"error":{"code":"wrong","message":"queue full"}}),
            Some("invalid tgrep error response"),
        ),
    ] {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        server.address = listener.local_addr().unwrap();
        thread::scope(|scope| {
            scope.spawn(|| {
                let (socket, _) = listener.accept().unwrap();
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket);
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let request: Value = serde_json::from_str(&request).unwrap();
                assert_eq!(request["instance"], "current");
                writeln!(reader.get_mut(), "{response}").unwrap();
            });
            let result = server.rpc("hello", json!({}), &token, Instant::now() + TIMEOUT);
            match expected {
                Some(message) => assert!(result.unwrap_err().to_string().contains(message)),
                None => assert!(result.is_ok()),
            }
        });
    }
}

#[test]
fn managed_protocol_authenticates_and_rejects_wrong_identity_and_untyped_errors() {
    use std::net::TcpListener;
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    let token = CancellationSource::new().token();
    let mut server = Server::start(
        &Executable::resolve(&InstallContext::current()).unwrap(),
        root.path(),
        index.path(),
        &token,
    )
    .unwrap();
    server.protocol = Protocol::Managed(ManagedIdentity {
        registration: ManagedDiscovery {
            pid: 0,
            port: 1,
            protocol: 2,
            namespace: "namespace".into(),
            instance: "instance".into(),
            repository: "repository".into(),
            storage: index.path().into(),
        },
        authorization: "test-private-token".into(),
    });
    let success = json!({"jsonrpc":"2.0","id":1,"result":{"protocol":2,"namespace":"namespace","instance":"instance","repository":"repository","data":{"verified":true}}});
    let mut wrong_identity = success.clone();
    wrong_identity["result"]["namespace"] = json!("another-namespace");
    let failure = |category: &str, reason: &str| json!({"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"test failure","data":{"category":category,"reason_code":reason,"retryable":true,"committed_state":"not-committed","detail":"test failure"}}});
    for (response, expected) in [
        (success, "success"),
        (wrong_identity, "identity"),
        (failure("busy", "view-not-ready"), "readiness"),
        (failure("busy", "query-input-changed"), "readiness"),
        (failure("busy", "query-limit"), "typed"),
        (failure("corrupt-metadata", "view-not-ready"), "typed"),
        (
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"view not ready"}}),
            "untyped",
        ),
    ] {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        server.address = listener.local_addr().unwrap();
        thread::scope(|scope| {
            scope.spawn(|| {
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket);
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let request: Value = serde_json::from_str(&request).unwrap();
                assert_eq!(request["protocol"], 2);
                assert_eq!(request["namespace"], "namespace");
                assert_eq!(request["instance"], "instance");
                assert_eq!(request["repository"], "repository");
                assert_eq!(request["authorization"], "test-private-token");
                writeln!(reader.get_mut(), "{response}").unwrap();
            });
            let result = server.rpc("hello", json!({}), &token, Instant::now() + TIMEOUT);
            match expected {
                "success" => assert_eq!(result.unwrap()["verified"], true),
                "identity" => assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("stale or incompatible")
                ),
                "readiness" => assert!(matches!(result, Err(Error::NotReady(_)))),
                "typed" => assert!(matches!(result, Err(Error::Management(_)))),
                "untyped" => assert!(matches!(result, Err(Error::Failed(_)))),
                _ => unreachable!(),
            }
        });
    }
}

#[test]
fn supervised_shutdown_keeps_an_unbound_live_owner_until_its_guard_ends() {
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    crate::tests::git(root.path(), &["init", "-b", "main"]);
    std::fs::write(root.path().join("source.rs"), "marker\n").unwrap();
    crate::tests::git(root.path(), &["add", "."]);
    crate::tests::git(
        root.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "fixture",
        ],
    );
    let executable = Executable::resolve(&InstallContext::current()).unwrap();
    let token = CancellationSource::new().token();
    let server = Server::start(
        &executable,
        &dunce::canonicalize(root.path()).unwrap(),
        index.path(),
        &token,
    )
    .unwrap();
    let deadline = Instant::now() + TIMEOUT;
    let owner = server
        .rpc(
            "owners.prepare",
            json!({"token":"unbound-owner"}),
            &token,
            deadline,
        )
        .unwrap();
    let path = index.path().join("external-claim.json");
    std::fs::write(&path, serde_json::to_vec(&owner["claim"]).unwrap()).unwrap();
    let guard = Owner::start(&executable, &path, &token, deadline).unwrap();
    server
        .rpc(
            "owners.register",
            json!({"claim":owner["claim"]}),
            &token,
            deadline,
        )
        .unwrap();
    drop(server.child.lock().unwrap().0.stdin.take());
    thread::sleep(Duration::from_millis(250));
    assert!(!server.is_stopped().unwrap());
    server.rpc("hello", json!({}), &token, deadline).unwrap();
    drop(guard);
    while !server.is_stopped().unwrap() {
        assert!(
            Instant::now() < deadline,
            "ended external owner was not reaped"
        );
        thread::sleep(POLL);
    }
}
