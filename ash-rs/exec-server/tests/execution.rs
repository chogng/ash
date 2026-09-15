#![cfg(unix)]

use exec_server::ExecClient;
use exec_server::RemoteEndpoint;
use exec_server_protocol::ExecError;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessSnapshot;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use exec_server_protocol::WriteCondition;
use std::io::BufRead;
use std::io::BufReader;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

struct Host {
    child: Child,
    root: tempfile::TempDir,
    endpoint: RemoteEndpoint,
    address: std::net::SocketAddr,
}
impl Host {
    fn start() -> Self {
        Self::with_access("read-write")
    }
    fn with_access(access: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let token_file = tempfile::NamedTempFile::new().unwrap();
        let token = "a1".repeat(32);
        std::fs::write(token_file.path(), &token).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_ash-exec-server"))
            .args(["--listen", "127.0.0.1:0", "--root"])
            .arg(root.path())
            .args(["--environment", "test", "--token-file"])
            .arg(token_file.path())
            .args(["--access", access])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx.recv_timeout(Duration::from_secs(15)).unwrap();
        let record: serde_json::Value = serde_json::from_str(&line).unwrap();
        let endpoint =
            RemoteEndpoint::new(record["address"].as_str().unwrap().parse().unwrap(), token)
                .unwrap();
        Self {
            child,
            root,
            endpoint,
            address: record["address"].as_str().unwrap().parse().unwrap(),
        }
    }
    fn client(&self) -> ExecClient {
        ExecClient::connect(self.endpoint.clone()).unwrap()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn command(id: &str, script: &str) -> ProcessStart {
    ProcessStart {
        operation_id: id.into(),
        program: "/bin/sh".into(),
        arguments: vec!["-c".into(), script.into()],
        cwd: ".".into(),
        input: exec_server_protocol::ProcessInput::Closed,
        timeout_millis: 10000,
    }
}
fn read(client: &ExecClient, id: &str) -> ProcessSnapshot {
    match client
        .request(Request::ProcessRead(ProcessRead {
            operation_id: id.into(),
            stdout_cursor: 0,
            stderr_cursor: 0,
        }))
        .unwrap()
    {
        Response::Process(snapshot) => snapshot,
        other => panic!("unexpected response: {other:?}"),
    }
}
fn finish(client: &ExecClient, id: &str) -> ProcessSnapshot {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let snapshot = read(client, id);
        if snapshot.state != ProcessState::Running {
            return snapshot;
        }
        assert!(Instant::now() < deadline, "process did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn process_survives_connection_replacement_without_reexecution() {
    let host = Host::start();
    let client = host.client();
    let start = command(
        "once",
        "printf x >> count; printf ready; sleep 0.2; printf done",
    );
    client
        .request(Request::ProcessStart(start.clone()))
        .unwrap();
    drop(client);
    let replacement = host.client();
    replacement.request(Request::ProcessStart(start)).unwrap();
    let result = finish(&replacement, "once");
    assert_eq!(
        result.state,
        ProcessState::Exited { code: Some(0) },
        "{result:?}"
    );
    assert_eq!(result.stdout.text, "readydone");
    assert_eq!(std::fs::read(host.root.path().join("count")).unwrap(), b"x");
    assert!(matches!(
        replacement.request(Request::ProcessStart(command("once", "echo changed"))),
        Err(exec_server::Error::Remote(ExecError::Conflict))
    ));
}

#[test]
fn cancellation_reaches_the_process_and_reports_a_terminal_state() {
    let host = Host::start();
    let client = host.client();
    client
        .request(Request::ProcessStart(command(
            "cancel",
            "printf started; sleep 10",
        )))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = read(&client, "cancel");
        assert_eq!(snapshot.state, ProcessState::Running, "{snapshot:?}");
        if snapshot.stdout.text.contains("started") {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    client
        .request(Request::ProcessCancel {
            operation_id: "cancel".into(),
        })
        .unwrap();
    assert_eq!(finish(&client, "cancel").state, ProcessState::Cancelled);
}

#[test]
fn file_writes_require_the_current_revision_and_reject_escape() {
    let host = Host::start();
    let client = host.client();
    client
        .request(Request::FileWrite {
            path: "file".into(),
            bytes: vec![0xff, 0, 1],
            condition: WriteCondition::MissingOrEmpty,
        })
        .unwrap();
    let Response::File(file) = client
        .request(Request::FileRead {
            path: "file".into(),
        })
        .unwrap()
    else {
        panic!("expected file");
    };
    assert_eq!(file.bytes, [0xff, 0, 1]);
    client
        .request(Request::FileWrite {
            path: "file".into(),
            bytes: b"new".to_vec(),
            condition: WriteCondition::ExpectedRevision(file.revision.clone()),
        })
        .unwrap();
    assert!(matches!(
        client.request(Request::FileWrite {
            path: "file".into(),
            bytes: b"stale".to_vec(),
            condition: WriteCondition::ExpectedRevision(file.revision)
        }),
        Err(exec_server::Error::Remote(ExecError::Conflict))
    ));
    assert!(matches!(
        client.request(Request::FileRead {
            path: "../escape".into()
        }),
        Err(exec_server::Error::Remote(ExecError::InvalidInput))
    ));
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), "secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), host.root.path().join("link")).unwrap();
    assert!(
        client
            .request(Request::FileRead {
                path: "link/secret".into()
            })
            .is_err()
    );
}

#[test]
fn process_input_works_after_reconnecting() {
    let host = Host::start();
    let client = host.client();
    let mut start = command(
        "pty",
        "printf ready; read answer; printf 'answer=%s' \"$answer\"",
    );
    start.input = exec_server_protocol::ProcessInput::Open;
    client.request(Request::ProcessStart(start)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !read(&client, "pty").stdout.text.contains("ready") {
        assert!(Instant::now() < deadline, "{:?}", read(&client, "pty"));
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(client);
    let client = host.client();
    client
        .request(Request::ProcessWrite {
            operation_id: "pty".into(),
            bytes: b"hello\n".to_vec(),
        })
        .unwrap();
    let snapshot = finish(&client, "pty");
    assert_eq!(
        snapshot.state,
        ProcessState::Exited { code: Some(0) },
        "{snapshot:?}"
    );
    assert!(
        snapshot.stdout.text.contains("answer=hello"),
        "{snapshot:?}"
    );
}

#[test]
fn host_ceiling_blocks_writes_even_for_authenticated_clients() {
    let host = Host::with_access("read-only");
    let client = host.client();
    assert!(matches!(
        client.request(Request::FileWrite {
            path: "denied".into(),
            bytes: b"x".to_vec(),
            condition: WriteCondition::MissingOrEmpty
        }),
        Err(exec_server::Error::Remote(ExecError::PermissionDenied))
    ));
    client
        .request(Request::ProcessStart(command(
            "denied",
            "printf x > denied",
        )))
        .unwrap();
    assert_ne!(
        finish(&client, "denied").state,
        ProcessState::Exited { code: Some(0) }
    );
    assert!(!host.root.path().join("denied").exists());
}

#[test]
fn rejects_wrong_credential_version_and_incarnation_before_mutation() {
    use std::io::Write;
    let host = Host::start();
    let info = host.client().info().clone();
    for (token, version, incarnation, expected) in [
        (
            "b2".repeat(32),
            exec_server_protocol::VERSION,
            info.incarnation.clone(),
            ExecError::Unauthorized,
        ),
        (
            "a1".repeat(32),
            exec_server_protocol::VERSION + 1,
            info.incarnation.clone(),
            ExecError::IncompatibleVersion,
        ),
        (
            "a1".repeat(32),
            exec_server_protocol::VERSION,
            "previous-instance".into(),
            ExecError::StaleEnvironment,
        ),
    ] {
        let mut stream = std::net::TcpStream::connect(host.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let message = exec_server_protocol::Message {
            token,
            version,
            incarnation: Some(incarnation),
            request: Request::FileWrite {
                path: "forbidden".into(),
                bytes: b"x".to_vec(),
                condition: WriteCondition::MissingOrEmpty,
            },
        };
        let mut bytes = serde_json::to_vec(&message).unwrap();
        bytes.push(b'\n');
        stream.write_all(&bytes).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        assert!(
            matches!(serde_json::from_str::<Response>(&line).unwrap(), Response::Error(error) if error == expected)
        );
        assert!(!host.root.path().join("forbidden").exists());
    }
}

#[test]
fn output_is_bounded_and_timeout_is_a_terminal_state() {
    let host = Host::start();
    let client = host.client();
    client
        .request(Request::ProcessStart(command(
            "output",
            "head -c 262144 /dev/zero | tr '\\0' x",
        )))
        .unwrap();
    let output = finish(&client, "output");
    assert_eq!(
        output.state,
        ProcessState::Exited { code: Some(0) },
        "{output:?}"
    );
    assert!(output.stdout.text.len() <= exec_server_protocol::MAX_OUTPUT_BYTES);
    assert!(output.stdout.gap, "truncated output must report a gap");
    let mut start = command("timeout", "sleep 10");
    start.timeout_millis = 100;
    client.request(Request::ProcessStart(start)).unwrap();
    assert_eq!(finish(&client, "timeout").state, ProcessState::TimedOut);
}

#[test]
fn shutdown_reaps_active_processes() {
    let mut host = Host::start();
    let client = host.client();
    client
        .request(Request::ProcessStart(command(
            "shutdown",
            "echo $$; exec sleep 60",
        )))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let pid = loop {
        let output = read(&client, "shutdown");
        if let Ok(pid) = output.stdout.text.trim().parse::<u32>() {
            break pid;
        }
        assert!(Instant::now() < deadline, "{output:?}");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(
        Command::new("kill")
            .args(["-TERM", &host.child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    loop {
        if let Some(status) = host.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "server did not shut down");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success(),
        "child survived server shutdown"
    );
}

#[test]
fn restricted_terminal_survives_reconnect_and_resizes() {
    let host = Host::start();
    let client = host.client();
    let mut start = command(
        "terminal",
        "test -t 0 && test -t 1 || exit 80; printf ready; read answer; stty size; printf 'answer=%s' \"$answer\"",
    );
    start.input = exec_server_protocol::ProcessInput::Terminal { rows: 24, cols: 80 };
    client.request(Request::ProcessStart(start)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = read(&client, "terminal");
        if snapshot.stdout.text.contains("ready") {
            break;
        }
        assert_eq!(snapshot.state, ProcessState::Running, "{snapshot:?}");
        assert!(Instant::now() < deadline, "{snapshot:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(client);
    let client = host.client();
    assert!(matches!(
        client.request(Request::ProcessCloseInput {
            operation_id: "terminal".into(),
        }),
        Err(exec_server::Error::Remote(ExecError::InvalidInput))
    ));
    assert!(matches!(
        client.request(Request::ProcessResize {
            operation_id: "terminal".into(),
            rows: 0,
            cols: 100,
        }),
        Err(exec_server::Error::Remote(ExecError::InvalidInput))
    ));
    client
        .request(Request::ProcessResize {
            operation_id: "terminal".into(),
            rows: 40,
            cols: 100,
        })
        .unwrap();
    client
        .request(Request::ProcessWrite {
            operation_id: "terminal".into(),
            bytes: b"hello\n".to_vec(),
        })
        .unwrap();
    let snapshot = finish(&client, "terminal");
    assert_eq!(
        snapshot.state,
        ProcessState::Exited { code: Some(0) },
        "{snapshot:?}"
    );
    assert!(snapshot.stdout.text.contains("40 100"), "{snapshot:?}");
    assert!(
        snapshot.stdout.text.contains("answer=hello"),
        "{snapshot:?}"
    );
}

#[test]
fn restricted_terminal_cannot_write_outside_host_ceiling() {
    let host = Host::with_access("read-only");
    let client = host.client();
    let mut start = command("terminal-denied", "test -t 0 || exit 80; printf x > denied");
    start.input = exec_server_protocol::ProcessInput::Terminal { rows: 24, cols: 80 };
    client.request(Request::ProcessStart(start)).unwrap();
    let snapshot = finish(&client, "terminal-denied");
    assert_ne!(snapshot.state, ProcessState::Exited { code: Some(0) });
    assert!(
        snapshot.stdout.text.to_lowercase().contains("permitted")
            || snapshot.stdout.text.to_lowercase().contains("denied"),
        "{snapshot:?}"
    );
    assert!(!host.root.path().join("denied").exists());
}

#[test]
fn cancelling_a_restricted_terminal_reaps_its_child() {
    let host = Host::start();
    let client = host.client();
    let mut start = command("terminal-cancel", "echo $$; exec sleep 60");
    start.input = exec_server_protocol::ProcessInput::Terminal { rows: 24, cols: 80 };
    client.request(Request::ProcessStart(start)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let pid = loop {
        let snapshot = read(&client, "terminal-cancel");
        if let Ok(pid) = snapshot.stdout.text.trim().parse::<u32>() {
            break pid;
        }
        assert_eq!(snapshot.state, ProcessState::Running, "{snapshot:?}");
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    };
    client
        .request(Request::ProcessCancel {
            operation_id: "terminal-cancel".into(),
        })
        .unwrap();
    assert_eq!(
        finish(&client, "terminal-cancel").state,
        ProcessState::Cancelled
    );
    loop {
        if !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
        {
            break;
        }
        assert!(Instant::now() < deadline, "PTY child survived cancellation");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn interrupting_a_restricted_terminal_stops_the_workload() {
    let host = Host::start();
    let client = host.client();
    let mut start = command("terminal-interrupt", "printf ready; exec sleep 60");
    start.input = exec_server_protocol::ProcessInput::Terminal { rows: 24, cols: 80 };
    client.request(Request::ProcessStart(start)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = read(&client, "terminal-interrupt");
        if snapshot.stdout.text.contains("ready") {
            break;
        }
        assert_eq!(snapshot.state, ProcessState::Running, "{snapshot:?}");
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    client
        .request(Request::ProcessInterrupt {
            operation_id: "terminal-interrupt".into(),
        })
        .unwrap();
    let snapshot = finish(&client, "terminal-interrupt");
    assert!(
        matches!(snapshot.state, ProcessState::Exited { .. }),
        "{snapshot:?}"
    );
    assert_ne!(snapshot.state, ProcessState::Exited { code: Some(0) });
}
