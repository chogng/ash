use ash_app_server_client::AppServerSession;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use tempfile::tempdir;

const SERVER_ID: &str = "user:mcp:restart";
const WAIT: Duration = Duration::from_secs(10);

#[test]
fn disabled_mcp_stays_disabled_after_a_temporary_connection_and_process_restart() {
    let root = tempdir().unwrap();
    let fixture = McpFixture::start();
    let start = || {
        AppServerSession::start_stdio(
            StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-app-server"))
                .with_argument("--listen")
                .with_argument("stdio://")
                .without_environment_variable("ASH_WORKSPACE_ROOT")
                .with_environment_variable("ASH_HOME", root.path().as_os_str()),
            ClientInfo {
                name: "mcp-restart-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap()
    };
    let first = start();
    let initial = call(&first, "config/read", json!({}));
    let configured = call(
        &first,
        "mcp/server/upsert",
        json!({
            "commandId": "disabled-mcp",
            "expectedRevision": initial["revision"],
            "server": {
                "id": SERVER_ID, "displayName": "Restart fixture",
                "transport": {"type": "streamableHttp", "url": fixture.url},
                "credential": {"type": "unauthenticated"},
                "enablement": "disabled"
            }
        }),
    );
    assert_status(&first, "disabled", 0);
    assert_eq!(fixture.initializations.load(Ordering::SeqCst), 0);

    // A successful real handshake makes this distinguish a temporary runtime connection
    // from a command that was merely accepted without ever reaching the MCP transport.
    assert_eq!(
        call(&first, "mcp/server/connect", json!({"serverId": SERVER_ID}))["intent"],
        "connect"
    );
    assert_status(&first, "connected", 1);
    let persisted = call(&first, "config/read", json!({}));
    assert_eq!(persisted["revision"], configured["revision"]);
    assert_eq!(persisted["mcpServers"][SERVER_ID]["enablement"], "disabled");
    first.shutdown().unwrap();
    let handshakes = fixture.initializations.load(Ordering::SeqCst);
    assert!(handshakes > 0);

    let second = start();
    assert_eq!(
        call(&second, "config/read", json!({}))["mcpServers"],
        persisted["mcpServers"]
    );
    assert_status(&second, "disabled", 0);
    second.shutdown().unwrap();
    assert_eq!(fixture.initializations.load(Ordering::SeqCst), handshakes);

    // The same persisted declaration still works after restart when explicitly connected.
    // This rules out a broken fixture or lost configuration explaining the disabled state.
    let third = start();
    call(&third, "mcp/server/connect", json!({"serverId": SERVER_ID}));
    assert_status(&third, "connected", 1);
    assert!(fixture.initializations.load(Ordering::SeqCst) > handshakes);
    third.shutdown().unwrap();
}

fn call(session: &AppServerSession, method: &str, params: Value) -> Value {
    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(100);
    let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let response = session
        .client()
        .into_transport()
        .round_trip(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        )
        .unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert!(response.get("error").is_none(), "{method}: {response}");
    response.get("result").expect("RPC result").clone()
}

fn assert_status(session: &AppServerSession, state: &str, tools: u64) {
    let deadline = Instant::now() + WAIT;
    loop {
        let snapshot = call(session, "mcp/server/status", json!({}));
        let server = snapshot["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|server| server["id"] == SERVER_ID)
            .expect("configured MCP server is listed");
        if server["state"]["status"] == state && server["toolCount"] == tools {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "expected {state} with {tools} tools: {snapshot}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// Stateless loopback MCP transport; the counter observes actual initialization, not RPC intent.
struct McpFixture {
    url: String,
    initializations: Arc<AtomicUsize>,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl McpFixture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let initializations = Arc::new(AtomicUsize::new(0));
        let count = initializations.clone();
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || {
            loop {
                match stopped.recv_timeout(Duration::from_millis(5)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let (mut socket, _) = match listener.accept() {
                    Ok(socket) => socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(error) => panic!("accept MCP request: {error}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(WAIT)).unwrap();
                socket.set_write_timeout(Some(WAIT)).unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let post = line.starts_with("POST ");
                let mut length = 0;
                loop {
                    line.clear();
                    assert!(
                        reader.read_line(&mut line).unwrap() > 0,
                        "incomplete HTTP request"
                    );
                    if line == "\r\n" {
                        break;
                    }
                    let (name, value) = line.trim().split_once(':').unwrap();
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
                // Streamable HTTP permits a stateless server without a GET notification stream.
                let (status, body) = if post {
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let request: Value = serde_json::from_slice(&body).unwrap();
                    if let Some(id) = request.get("id") {
                        let result = match request["method"].as_str().unwrap() {
                            "initialize" => {
                                count.fetch_add(1, Ordering::SeqCst);
                                json!({"protocolVersion": request["params"]["protocolVersion"],
                                "capabilities": {"tools": {}},
                                "serverInfo": {"name": "restart-fixture", "version": "1"}})
                            }
                            "tools/list" => json!({"tools": [{"name": "restart_probe",
                            "description": "Restart probe", "inputSchema": {"type": "object"}}]}),
                            method => panic!("unexpected MCP method {method}"),
                        };
                        (
                            "200 OK",
                            json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string(),
                        )
                    } else {
                        assert_eq!(request["method"], "notifications/initialized");
                        ("202 Accepted", String::new())
                    }
                } else {
                    ("405 Method Not Allowed", String::new())
                };
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        Self {
            url,
            initializations,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for McpFixture {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.expect("MCP fixture stopped");
        }
    }
}
