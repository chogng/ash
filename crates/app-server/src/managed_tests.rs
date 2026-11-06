#[test]
#[cfg(any(unix, windows))]
fn invalid_profile_config_is_rejected_before_daemon_socket_is_bound() {
    let profile = tempfile::tempdir().unwrap();
    std::fs::write(
        profile.path().join("config.toml"),
        "schemaVersion = 1\nunknownField = true\n",
    )
    .unwrap();
    let endpoint = ash_app_server_daemon::daemon_endpoint_path(profile.path()).unwrap();

    let error = super::run(
        profile.path().to_path_buf(),
        None,
        ash_app_server_diff::compute,
        build_info::BuildInfo::new(None, None),
    )
    .unwrap_err();

    assert!(error.contains("unknown field `unknownField`"));
    assert!(!endpoint.exists());
}

use std::io;

use super::is_peer_disconnect;

#[test]
fn workbench_hello_responds_before_consuming_the_directory_initialize() {
    let hello = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"transport/hello\",\"params\":null}\n";
    let initialize = "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"initialize\",\"params\":{}}\n";
    let mut input = io::Cursor::new(format!("{hello}{initialize}").into_bytes());
    let mut output = Vec::new();
    let first = super::read_workbench_hello(&mut input, &mut output).unwrap();
    assert!(matches!(first, super::WorkbenchFirstFrame::Hello(1)));
    let reply: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(
        reply["result"]["schemaHash"],
        ash_app_server_protocol::schema_hash()
    );
    assert_eq!(
        &input.get_ref()[input.position() as usize..],
        initialize.as_bytes()
    );

    output.clear();
    let first = super::read_workbench_hello(io::Cursor::new(initialize), &mut output).unwrap();
    assert!(
        matches!(first, super::WorkbenchFirstFrame::Replay(bytes) if bytes == initialize.as_bytes())
    );
    assert!(output.is_empty());
}

#[test]
fn peer_disconnects_are_normal_transport_shutdowns() {
    for kind in [
        io::ErrorKind::BrokenPipe,
        io::ErrorKind::ConnectionAborted,
        io::ErrorKind::ConnectionReset,
    ] {
        assert!(is_peer_disconnect(&io::Error::from(kind)));
    }
    assert!(!is_peer_disconnect(&io::Error::from(
        io::ErrorKind::PermissionDenied
    )));
}

#[test]
#[cfg(any(unix, windows))]
fn connection_workers_close_sockets_and_release_services_before_returning() {
    use ash_app_server_transport::LocalConnections;
    use ash_app_server_transport::LocalStream;
    use ash_uds::IpcStream;
    use std::io::Read;
    use std::sync::Arc;

    let (stream, peer) = IpcStream::pair().unwrap();
    let (mut reader, writer) = LocalStream::pair(stream).unwrap();
    let connections = Arc::new(LocalConnections::new());
    let registration = connections.register(writer.shutdown_handle()).unwrap();
    let service = Arc::new(());
    let released = Arc::downgrade(&service);
    let (ended, completion) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _service = service;
        let _registration = registration;
        ended.send(reader.read(&mut [0])).unwrap();
    });
    let workers = super::ConnectionWorkers {
        connections: Arc::clone(&connections),
        workers: vec![worker],
    };

    // Keep the peer open and silent. If shutdown fails, closing it here also unblocks the join.
    let (joined, shutdown) = std::sync::mpsc::channel();
    let owner = std::thread::spawn(move || {
        drop(workers);
        joined.send(()).unwrap();
    });
    let result = shutdown.recv_timeout(std::time::Duration::from_secs(5));
    drop(peer);
    owner.join().unwrap();
    result.expect("managed connection owner did not finish shutdown");

    let closed = completion.recv().unwrap();
    assert!(
        matches!(closed, Ok(0))
            || closed.as_ref().is_err_and(|error| matches!(
                error.kind(),
                io::ErrorKind::NotConnected
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::BrokenPipe
            )),
        "connection did not close: {closed:?}"
    );
    assert!(connections.is_empty());
    assert!(released.upgrade().is_none());
}

#[test]
#[cfg(any(unix, windows))]
fn managed_stop_returns_after_connections_and_services_are_released() {
    use ash_app_server_daemon::daemon_endpoint_path;
    use ash_uds::IpcStream;
    use std::io::BufRead;
    use std::io::BufReader;
    use std::io::Write;
    use std::process::Command;
    use std::process::Stdio;
    use std::time::Duration;
    use std::time::Instant;

    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut child = Child(
        Command::new(
            std::env::var_os("ASH_MANAGED_LIFECYCLE_TEST_HOST")
                .expect("run through scripts/cargo.py to prepare the managed lifecycle host"),
        )
        .arg(ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT)
        .env("ASH_HOME", profile.path())
        .stdout(Stdio::null())
        .spawn()
        .unwrap(),
    );
    let endpoint = daemon_endpoint_path(profile.path()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut stream = loop {
        if let Ok(stream) = IpcStream::connect(&endpoint) {
            break stream;
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "managed child exited during startup"
        );
        assert!(
            Instant::now() < deadline,
            "managed child did not bind its endpoint"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    writeln!(
        stream,
        "{}",
        serde_json::json!({
            "version": 1, "dirRoot": directory.path(), "dirGrantSource": "hostConfiguration",
            "productServices": null,
        })
    )
    .unwrap();
    writeln!(stream, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"clientInfo": {"name": "managed-stop-test", "version": "1"}, "capabilities": {}},
    })).unwrap();
    stream.flush().unwrap();
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    assert_ne!(
        reader.read_line(&mut response).unwrap(),
        0,
        "managed connection closed before initialize"
    );
    let response: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert!(response["result"].is_object());

    let mut control = IpcStream::connect(&endpoint).unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    writeln!(
        control,
        "{}",
        serde_json::json!({"version": 1, "kind": "control", "command": "stop"})
    )
    .unwrap();
    let mut response = String::new();
    BufReader::new(control).read_line(&mut response).unwrap();
    let response: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["state"], "stopping");

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "managed child failed: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "managed child did not finish shutdown"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read(profile.path().join("released")).unwrap(),
        b"released"
    );
    assert!(!endpoint.exists());
    assert!(!endpoint.with_extension("pid.json").exists());
    assert!(IpcStream::connect(endpoint).is_err());
}

#[cfg(unix)]
#[test]
fn managed_forced_exit_reclaims_owned_extension_sessions_and_allows_profile_restart() {
    use ash_app_server_daemon::ConnectionOptions;
    use ash_app_server_daemon::GrantSource;
    use ash_app_server_daemon::LifecycleCommand;
    use ash_app_server_daemon::LifecycleStatus;
    use ash_app_server_daemon::run_lifecycle;
    use ash_uds::IpcStream;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process::Command;
    use std::process::Stdio;
    use std::time::Duration;
    use std::time::Instant;

    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let executable = PathBuf::from(
        std::env::var_os("ASH_MANAGED_LIFECYCLE_TEST_HOST").expect("managed lifecycle test host"),
    );
    for scenario in ["killed", "extension-stopped", "daemon-stopped"] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let mut child = Child(
            Command::new(&executable)
                .arg(ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT)
                .env("ASH_HOME", profile.path())
                .env("ASH_TEST_MANAGED_OWNED_PROCESSES", directory.path())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let endpoint = ash_app_server_daemon::daemon_endpoint_path(profile.path()).unwrap();
        let options =
            ConnectionOptions::new(profile.path(), None, GrantSource::HostConfiguration, None);
        let deadline = Instant::now() + Duration::from_secs(30);
        while !directory.path().join("descendant").exists()
            || IpcStream::connect(&endpoint).is_err()
        {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "managed fixture exited during startup"
            );
            assert!(Instant::now() < deadline, "managed fixture did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = run_lifecycle(LifecycleCommand::Version, options.clone(), &executable).unwrap();
        assert_eq!(ready.status, LifecycleStatus::Running);
        assert_eq!(ready.pid, Some(child.0.id()));
        let owned = ["leader", "descendant"].map(|name| {
            let contents = std::fs::read_to_string(directory.path().join(name)).unwrap();
            let (pid, address) = contents.split_once(' ').unwrap();
            (pid.parse::<u32>().unwrap(), address.to_owned())
        });
        assert!(TcpListener::bind(&owned[0].1).is_err());
        let daemon_pid = child.0.id();
        let stopped_pid = match scenario {
            "extension-stopped" => Some(owned[0].0),
            "daemon-stopped" => Some(daemon_pid),
            "killed" => None,
            _ => unreachable!(),
        };
        if let Some(pid) = stopped_pid {
            assert!(
                Command::new("kill")
                    .args(["-STOP", &pid.to_string()])
                    .status()
                    .unwrap()
                    .success()
            );
        }
        if scenario == "daemon-stopped" {
            let stopped =
                run_lifecycle(LifecycleCommand::Stop, options.clone(), &executable).unwrap();
            assert_eq!(stopped.status, LifecycleStatus::Stopped);
        } else {
            child.0.kill().unwrap();
        }
        child.0.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        for (pid, address) in &owned {
            loop {
                let dead = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "stat="])
                    .output()
                    .unwrap();
                let status = String::from_utf8_lossy(&dead.stdout);
                if (!dead.status.success() || status.trim().starts_with('Z'))
                    && TcpListener::bind(address).is_ok()
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "owned extension {pid} retained its process or listener"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        assert!(IpcStream::connect(&endpoint).is_err());
        // Reuse this exact profile and endpoint after a forced exit left its on-disk
        // rendezvous record behind. A new generation must claim and release it safely.
        let mut replacement = Child(
            Command::new(&executable)
                .arg(ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT)
                .env("ASH_HOME", profile.path())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        while IpcStream::connect(&endpoint).is_err() {
            assert!(replacement.0.try_wait().unwrap().is_none());
            assert!(
                Instant::now() < deadline,
                "profile endpoint was not recovered"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = run_lifecycle(LifecycleCommand::Version, options.clone(), &executable).unwrap();
        assert_eq!(ready.status, LifecycleStatus::Running);
        assert_eq!(ready.pid, Some(replacement.0.id()));
        assert_eq!(
            run_lifecycle(LifecycleCommand::Stop, options, &executable)
                .unwrap()
                .status,
            LifecycleStatus::Stopped
        );
        assert!(replacement.0.wait().unwrap().success());
    }
}
