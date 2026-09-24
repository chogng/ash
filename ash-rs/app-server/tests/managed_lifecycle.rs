#![cfg(any(unix, windows))]

use std::fs::OpenOptions;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::GrantSource;
use ash_app_server_daemon::LifecycleCommand;
use ash_app_server_daemon::LifecycleStatus;
use ash_app_server_daemon::daemon_endpoint_path;
use ash_app_server_daemon::run_lifecycle;
use ash_uds::UnixStream;
use serde_json::json;

struct StopOnDrop<'a> {
    options: ConnectionOptions,
    executable: &'a Path,
}

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        let _ = run_lifecycle(
            LifecycleCommand::Stop,
            self.options.clone(),
            self.executable,
        );
    }
}

#[test]
fn lifecycle_commands_are_idempotent_and_probe_initialize() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let dir = root.path().join("dir");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&dir).unwrap();
    let options = ConnectionOptions::new(&profile, Some(dir), GrantSource::HostConfiguration, None);
    let executable = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let cleanup = StopOnDrop {
        options: options.clone(),
        executable,
    };

    let started = run_lifecycle(LifecycleCommand::Start, options.clone(), executable).unwrap();
    assert_eq!(started.status, LifecycleStatus::Started);
    assert_eq!(started.app_server_name.as_deref(), Some("ash-app-server"));
    assert!(
        started
            .schema_hash
            .as_deref()
            .is_some_and(|hash| hash.starts_with("sha256:"))
    );
    assert!(started.pid.is_some());
    assert_ne!(started.pid, Some(std::process::id()));
    let record_path = daemon_endpoint_path(&profile)
        .unwrap()
        .with_extension("pid.json");
    let record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(record_path).unwrap()).unwrap();
    assert_eq!(record["pid"].as_u64(), started.pid.map(u64::from));
    assert!(
        record["processStartIdentity"]
            .as_str()
            .is_some_and(|identity| !identity.is_empty())
    );
    assert!(started.instance_id.is_some());

    let already = run_lifecycle(LifecycleCommand::Start, options.clone(), executable).unwrap();
    assert_eq!(already.status, LifecycleStatus::AlreadyRunning);
    assert_eq!(already.pid, started.pid);
    assert_eq!(already.instance_id, started.instance_id);

    let running = run_lifecycle(LifecycleCommand::Version, options.clone(), executable).unwrap();
    assert_eq!(running.status, LifecycleStatus::Running);
    assert_eq!(running.pid, started.pid);

    let restarted = run_lifecycle(LifecycleCommand::Restart, options.clone(), executable).unwrap();
    assert_eq!(restarted.status, LifecycleStatus::Restarted);
    assert_ne!(restarted.instance_id, started.instance_id);
    assert_eq!(restarted.app_server_name.as_deref(), Some("ash-app-server"));

    let stopped = run_lifecycle(LifecycleCommand::Stop, options.clone(), executable).unwrap();
    assert_eq!(stopped.status, LifecycleStatus::Stopped);
    assert_eq!(stopped.instance_id, restarted.instance_id);

    let not_running = run_lifecycle(LifecycleCommand::Version, options, executable).unwrap();
    assert_eq!(not_running.status, LifecycleStatus::NotRunning);
    assert!(not_running.pid.is_none());
    drop(cleanup);
}

#[test]
fn start_reuses_a_compatible_daemon_from_another_installation() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let dir = root.path().join("dir");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&dir).unwrap();
    let options = ConnectionOptions::new(&profile, Some(dir), GrantSource::HostConfiguration, None);
    let packaged = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let first_executable = root.path().join("daemon-first");
    let second_executable = root.path().join("daemon-second");
    std::fs::copy(packaged, &first_executable).unwrap();
    std::fs::copy(packaged, &second_executable).unwrap();
    OpenOptions::new()
        .append(true)
        .open(&second_executable)
        .unwrap()
        .write_all(&[0])
        .unwrap();
    let cleanup = StopOnDrop {
        options: options.clone(),
        executable: &second_executable,
    };

    let first = run_lifecycle(LifecycleCommand::Start, options.clone(), &first_executable).unwrap();
    let attached = run_lifecycle(LifecycleCommand::Start, options, &second_executable).unwrap();

    assert_eq!(first.status, LifecycleStatus::Started);
    assert_eq!(attached.status, LifecycleStatus::AlreadyRunning);
    assert_eq!(attached.pid, first.pid);
    assert_eq!(attached.instance_id, first.instance_id);
    drop(cleanup);
}

#[cfg(unix)]
#[test]
fn changed_source_executable_does_not_interrupt_a_running_daemon() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let dir = root.path().join("dir");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&dir).unwrap();
    let options = ConnectionOptions::new(&profile, Some(dir), GrantSource::HostConfiguration, None);
    let packaged = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let source = root.path().join(if cfg!(windows) {
        "ash-app-server-daemon.exe"
    } else {
        "ash-app-server-daemon"
    });
    std::fs::copy(packaged, &source).unwrap();
    let cleanup = StopOnDrop {
        options: options.clone(),
        executable: &source,
    };

    let started = run_lifecycle(LifecycleCommand::Start, options.clone(), &source).unwrap();
    std::fs::remove_file(&source).unwrap();
    std::fs::copy(packaged, &source).unwrap();
    OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(&[0])
        .unwrap();
    let attached = run_lifecycle(LifecycleCommand::Start, options.clone(), &source).unwrap();

    assert_eq!(started.status, LifecycleStatus::Started);
    assert_eq!(attached.status, LifecycleStatus::AlreadyRunning);
    assert_eq!(started.instance_id, attached.instance_id);
    let restarted = run_lifecycle(LifecycleCommand::Restart, options, &source).unwrap();
    assert_eq!(restarted.status, LifecycleStatus::Restarted);
    assert_ne!(started.instance_id, restarted.instance_id);
    drop(cleanup);
}

#[test]
fn concurrent_starts_publish_one_process_generation() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let dir = root.path().join("dir");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&dir).unwrap();
    let options = ConnectionOptions::new(&profile, Some(dir), GrantSource::HostConfiguration, None);
    let executable = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let cleanup = StopOnDrop {
        options: options.clone(),
        executable,
    };
    let first_options = options.clone();
    let second_options = options.clone();
    let first = std::thread::spawn(move || {
        run_lifecycle(LifecycleCommand::Start, first_options, executable).unwrap()
    });
    let second = std::thread::spawn(move || {
        run_lifecycle(LifecycleCommand::Start, second_options, executable).unwrap()
    });
    let first = first.join().unwrap();
    let second = second.join().unwrap();

    assert_eq!(first.pid, second.pid);
    assert_eq!(first.instance_id, second.instance_id);
    assert_eq!(
        [first.status, second.status]
            .into_iter()
            .filter(|status| *status == LifecycleStatus::Started)
            .count(),
        1
    );
    assert_eq!(
        [first.status, second.status]
            .into_iter()
            .filter(|status| *status == LifecycleStatus::AlreadyRunning)
            .count(),
        1
    );
    drop(cleanup);
}

#[test]
fn stop_closes_active_connections_after_its_bounded_grace_window() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let dir = root.path().join("dir");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&dir).unwrap();
    let options = ConnectionOptions::new(
        &profile,
        Some(dir.clone()),
        GrantSource::HostConfiguration,
        None,
    );
    let executable = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let cleanup = StopOnDrop {
        options: options.clone(),
        executable,
    };
    run_lifecycle(LifecycleCommand::Start, options.clone(), executable).unwrap();
    let mut stream = UnixStream::connect(daemon_endpoint_path(&profile).unwrap()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    writeln!(
        stream,
        "{}",
        json!({
            "version": 1,
            "dirRoot": dir,
            "dirGrantSource": "hostConfiguration",
            "productServices": null,
        })
    )
    .unwrap();
    writeln!(
        stream,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "active-stop-test", "version": "1"},
                "capabilities": {},
            },
        })
    )
    .unwrap();
    stream.flush().unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut initialize = String::new();
    reader.read_line(&mut initialize).unwrap();
    assert!(initialize.contains("\"result\""));

    let stop_options = options.clone();
    let stopped = std::thread::spawn(move || {
        run_lifecycle(LifecycleCommand::Stop, stop_options, executable).unwrap()
    })
    .join()
    .unwrap();
    assert_eq!(stopped.status, LifecycleStatus::Stopped);
    let mut after_stop = String::new();
    match reader.read_line(&mut after_stop) {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
            ) => {}
        result => panic!("active connection remained readable after stop: {result:?}"),
    }
    drop(stream);
    drop(cleanup);
}

#[test]
fn failed_initialize_cleans_the_published_backend_before_retry() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let services = root.path().join("services.json");
    std::fs::write(&services, r#"{"schemaVersion":1}"#).unwrap();
    let options = ConnectionOptions::new(
        &profile,
        None,
        GrantSource::HostConfiguration,
        Some(services.clone()),
    );
    let executable = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let error = run_lifecycle(LifecycleCommand::Start, options.clone(), executable).unwrap_err();
    assert!(error.contains("initialize"), "{error}");
    let endpoint = daemon_endpoint_path(&profile).unwrap();
    assert!(!endpoint.with_extension("pid.json").exists());
    assert!(!endpoint.exists());

    std::fs::write(&services, r#"{"schemaVersion":2}"#).unwrap();
    let cleanup = StopOnDrop {
        options: options.clone(),
        executable,
    };
    let started = run_lifecycle(LifecycleCommand::Start, options, executable).unwrap();
    assert_eq!(started.status, LifecycleStatus::Started);
    drop(cleanup);
}

#[test]
fn web_launch_reuses_the_managed_process_and_releases_its_listener() {
    use std::io::Read;
    use std::process::Command;
    use std::process::Stdio;
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("p");
    let dir = root.path().join("d");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&dir).unwrap();
    let options = ConnectionOptions::new(
        &profile,
        Some(dir.clone()),
        GrantSource::HostConfiguration,
        None,
    );
    let executable = Path::new(env!("CARGO_BIN_EXE_ash-app-server"));
    let _cleanup = StopOnDrop {
        options: options.clone(),
        executable,
    };
    let started = run_lifecycle(LifecycleCommand::Start, options.clone(), executable).unwrap();
    struct Launcher(std::process::Child);
    impl Drop for Launcher {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut launch = Launcher(
        Command::new(executable)
            .args(["--web", "--port", "0"])
            .env("ASH_HOME", &profile)
            .env("ASH_WORKSPACE_ROOT", &dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = launch.0.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(20))
        .unwrap()
        .unwrap();
    let info: ash_app_server_protocol::WebListenInfo = serde_json::from_str(&line).unwrap();
    assert_eq!(Some(info.pid), started.pid);
    let authority = info
        .endpoint
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let mut http = std::net::TcpStream::connect(authority).unwrap();
    http.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(http, "POST /ash/session HTTP/1.1\r\nHost: {authority}\r\nOrigin: http://{authority}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", info.ticket.len(), info.ticket).unwrap();
    let mut response = String::new();
    http.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let session: ash_app_server_protocol::WebSessionInfo =
        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert!(session.workspace_id.starts_with("sha256:"));
    drop(launch.0.stdin.take());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while launch.0.try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "Web launcher did not exit after stdin closed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(std::net::TcpStream::connect(authority).is_err());
    let still_running = run_lifecycle(LifecycleCommand::Version, options, executable).unwrap();
    assert_eq!(still_running.pid, started.pid);
}
