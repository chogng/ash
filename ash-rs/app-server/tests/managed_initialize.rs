#![cfg(any(unix, windows))]

use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::process::Child;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;

use ash_app_server_daemon::daemon_endpoint_path;
use ash_remote::{RemoteDirPath, RemoteProfile, RemoteRuntime, SshHost, SshTarget};
use ash_remote_profile_store::RemoteConnectionProfileStore;
use ash_uds::UnixStream;
use serde_json::Value;
use serde_json::json;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn daemon_keeps_a_directory_connection_open_after_initialize() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("p");
    let dir = root.path().join("dir");
    let product_services = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/managed-product-services.json");
    fs::create_dir(&profile).unwrap();
    fs::create_dir(&dir).unwrap();
    let endpoint = daemon_endpoint_path(&profile).unwrap();
    let daemon = Command::new(env!("CARGO_BIN_EXE_ash-app-server"))
        .arg(ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT)
        .env("ASH_HOME", &profile)
        .env("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "5000")
        .spawn()
        .unwrap();
    let _daemon = Daemon(daemon);
    let mut stream = connect_when_ready(&endpoint);
    stream.set_read_timeout(Some(CONNECT_TIMEOUT)).unwrap();
    writeln!(
        stream,
        "{}",
        json!({
            "version": 1,
            "dirRoot": dir,
            "dirGrantSource": "hostConfiguration",
            "productServices": product_services,
        })
    )
    .unwrap();
    writeln!(
        stream,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"clientInfo":{{"name":"daemon-test","version":"1"}},"capabilities":{{}}}}}}"#
    )
    .unwrap();
    stream.flush().unwrap();

    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut response = String::new();
    reader.read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();

    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["serverInfo"]["name"], "ash-app-server");
    assert!(response["result"]["schemaHash"].as_str().is_some());

    std::thread::sleep(Duration::from_millis(100));
    writeln!(
        stream,
        "{}",
        json!({"jsonrpc":"2.0","id":2,"method":"session/list","params":{}})
    )
    .unwrap();
    stream.flush().unwrap();

    let mut response = String::new();
    reader.read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["id"], 2);
    assert!(response["result"].is_object());

    writeln!(
        stream,
        "{}",
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "marketplace/search", "params": {"query": ""}
        })
    )
    .unwrap();
    stream.flush().unwrap();
    let mut response = String::new();
    reader.read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["id"], 3);
    assert_eq!(response["result"]["packages"], json!([]));
}

#[test]
fn agents_connection_keeps_sessions_in_two_local_directories() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let first = root.path().join("first");
    let second = root.path().join("second");
    fs::create_dir(&profile).unwrap();
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let endpoint = daemon_endpoint_path(&profile).unwrap();
    let daemon = Command::new(env!("CARGO_BIN_EXE_ash-app-server"))
        .arg(ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT)
        .env("ASH_HOME", &profile)
        .env("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "5000")
        .spawn()
        .unwrap();
    let _daemon = Daemon(daemon);
    let mut stream = connect_when_ready(&endpoint);
    stream.set_read_timeout(Some(CONNECT_TIMEOUT)).unwrap();
    writeln!(
        stream,
        "{}",
        json!({"version":1,"role":"agents","dirGrantSource":"hostConfiguration"})
    )
    .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    for (id, method, params) in [
        (
            1,
            "initialize",
            json!({"clientInfo":{"name":"agents-test","version":"1"},"capabilities":{}}),
        ),
        (
            2,
            "session/create",
            json!({"commandId":"agents-first","title":"First","executionTarget":{"type":"local","root":first}}),
        ),
        (
            3,
            "session/create",
            json!({"commandId":"agents-second","title":"Second","executionTarget":{"type":"local","root":second}}),
        ),
        (4, "session/list", json!({})),
    ] {
        writeln!(
            stream,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        stream.flush().unwrap();
        let response = loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .unwrap_or_else(|error| panic!("Agents {method} response timed out: {error}"));
            let response: Value = serde_json::from_str(&line).unwrap();
            if response.get("id") == Some(&json!(id)) {
                break response;
            }
        };
        assert!(response.get("error").is_none(), "{response}");
        if id == 4 {
            let sessions = response["result"]["sessions"].as_array().unwrap();
            assert_eq!(sessions.len(), 2, "{response}");
            assert!(sessions.iter().any(|session| session["title"] == "First"
                && session["executionTarget"]["root"]
                    == first.canonicalize().unwrap().to_string_lossy().as_ref()));
            assert!(sessions.iter().any(|session| session["title"] == "Second"
                && session["executionTarget"]["root"]
                    == second.canonicalize().unwrap().to_string_lossy().as_ref()));
        }
    }
}

#[test]
fn agents_connection_routes_ssh_sessions_and_merges_the_catalog() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let remote_home = root.path().join("remote-profile");
    let remote_dir = root.path().join("remote-project");
    fs::create_dir(&profile).unwrap();
    fs::create_dir(&remote_home).unwrap();
    fs::create_dir(&remote_dir).unwrap();
    let remote_root = remote_dir
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let remote_profile = RemoteProfile::new(
        SshTarget::new(
            SshHost::parse("test-host").unwrap(),
            RemoteDirPath::parse(&remote_root).unwrap(),
        ),
        RemoteRuntime::new("ash-app-server").unwrap(),
    );
    RemoteConnectionProfileStore::from_profile_root(&profile)
        .activate(&remote_profile)
        .unwrap();
    let ssh_stub = root.path().join(if cfg!(windows) {
        "ssh-stub.cmd"
    } else {
        "ssh-stub.sh"
    });
    let executable = env!("CARGO_BIN_EXE_ash-app-server");
    if cfg!(windows) {
        fs::write(&ssh_stub, format!("@echo off\r\nset \"ASH_HOME={}\"\r\nset \"ASH_WORKSPACE_ROOT={}\"\r\n\"{}\" --listen stdio://\r\n", remote_home.display(), remote_root, executable)).unwrap();
    } else {
        fs::write(&ssh_stub, format!("#!/bin/sh\nexport ASH_HOME='{}'\nexport ASH_WORKSPACE_ROOT='{}'\nexec '{}' --listen stdio://\n", remote_home.display(), remote_root, executable)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&ssh_stub, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    let endpoint = daemon_endpoint_path(&profile).unwrap();
    let daemon = Command::new(executable)
        .arg(ash_app_server_daemon::MANAGED_PROCESS_ARGUMENT)
        .env("ASH_HOME", &profile)
        .env("ASH_SSH_PATH", &ssh_stub)
        .env("ASH_LOCAL_APP_SERVER_IDLE_TIMEOUT_MILLIS", "5000")
        .spawn()
        .unwrap();
    let _daemon = Daemon(daemon);
    let mut stream = connect_when_ready(&endpoint);
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    writeln!(
        stream,
        "{}",
        json!({"version":1,"role":"agents","dirGrantSource":"hostConfiguration"})
    )
    .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut call = |id: u64, method: &str, params: Value| -> Value {
        writeln!(
            stream,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        stream.flush().unwrap();
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .unwrap_or_else(|error| panic!("Agents {method} response timed out: {error}"));
            let response: Value = serde_json::from_str(&line).unwrap();
            if response.get("id") == Some(&json!(id)) {
                return response;
            }
        }
    };
    assert!(
        call(
            1,
            "initialize",
            json!({"clientInfo":{"name":"agents-ssh-test","version":"1"},"capabilities":{}})
        )
        .get("result")
        .is_some()
    );
    let created = call(
        2,
        "session/create",
        json!({"commandId":"remote-task","title":"Remote task","executionTarget":{"type":"ssh","host":"test-host","root":remote_root}}),
    );
    assert!(created.get("error").is_none(), "{created}");
    assert_eq!(
        created["result"]["session"]["executionTarget"],
        json!({"type":"ssh","host":"test-host","root":remote_root})
    );
    let session_id = created["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = call(
        3,
        "session/request",
        json!({"commandId":"remote-thread","sessionId":session_id,"expectedSequence":1,"request":{"type":"createThread","title":"Main"}}),
    );
    assert!(thread.get("error").is_none(), "{thread}");
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let listed = call(4, "session/list", json!({}));
    assert!(listed.get("error").is_none(), "{listed}");
    assert!(
        listed["result"]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["sessionId"] == session_id)
    );
    let read = call(5, "session/read", json!({"sessionId":session_id}));
    assert!(read.get("error").is_none(), "{read}");
    assert_eq!(
        read["result"]["session"]["executionTarget"]["host"],
        "test-host"
    );
    assert_eq!(
        read["result"]["session"]["threads"][0]["threadId"],
        thread_id
    );
}

fn connect_when_ready(endpoint: &std::path::Path) -> UnixStream {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match UnixStream::connect(endpoint) {
            Ok(stream) => return stream,
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!("daemon endpoint did not become ready: {error}"),
        }
    }
}
