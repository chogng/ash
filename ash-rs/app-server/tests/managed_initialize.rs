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
