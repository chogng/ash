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

    let error = super::run(profile.path().to_path_buf(), None).unwrap_err();

    assert!(error.contains("unknown field `unknownField`"));
    assert!(!endpoint.exists());
}

use std::io;

use super::is_peer_disconnect;

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
    use ash_uds::UnixStream;
    use std::io::Read;
    use std::sync::Arc;

    let (mut stream, _peer) = UnixStream::pair().unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    let connections = Arc::new(LocalConnections::new());
    let registration = connections.register(stream.try_clone().unwrap()).unwrap();
    let service = Arc::new(());
    let released = Arc::downgrade(&service);
    let (ended, completion) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _service = service;
        let _registration = registration;
        ended.send(stream.read(&mut [0])).unwrap();
    });
    let workers = super::ConnectionWorkers {
        connections: Arc::clone(&connections),
        workers: vec![worker],
    };

    drop(workers);

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
    use ash_uds::UnixStream;
    use std::io::BufRead;
    use std::io::BufReader;
    use std::io::Write;
    use std::process::Command;
    use std::process::Stdio;
    use std::time::Duration;
    use std::time::Instant;

    const CHILD_PROFILE: &str = "ASH_TEST_MANAGED_STOP_PROFILE";
    if let Some(profile) = std::env::var_os(CHILD_PROFILE) {
        let profile = std::path::PathBuf::from(profile);
        super::run(profile.clone(), None).unwrap();
        // A forced process exit cannot produce this acknowledgement. It is written
        // only after the real managed entrypoint has returned and dropped its owners.
        std::fs::write(profile.join("released"), b"released").unwrap();
        return;
    }

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
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "managed::tests::managed_stop_returns_after_connections_and_services_are_released",
                "--nocapture",
            ])
            .env(CHILD_PROFILE, profile.path())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let endpoint = daemon_endpoint_path(profile.path()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut stream = loop {
        if let Ok(stream) = UnixStream::connect(&endpoint) {
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
    reader.read_line(&mut response).unwrap();
    let response: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert!(response["result"].is_object());

    let mut control = UnixStream::connect(&endpoint).unwrap();
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
    assert!(UnixStream::connect(endpoint).is_err());
}
