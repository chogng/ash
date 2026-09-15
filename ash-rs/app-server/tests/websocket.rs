use std::io::BufRead;
use std::io::BufReader;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use ash_app_server_protocol::AppServerListenInfo;
use futures::SinkExt;
use futures::StreamExt;
use sha2::Digest;
use sha2::Sha256;
use tempfile::tempdir;
use tokio::net::TcpStream;
use tokio_tungstenite::client_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

const TOKEN: &str = "app-server-process-websocket-token";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

#[test]
fn app_server_emits_a_valid_listen_record_and_serves_websocket_requests() {
    let profile = tempdir().unwrap();
    let digest = Sha256::digest(TOKEN.as_bytes());
    let mut child = ProcessGuard(
        Command::new(env!("CARGO_BIN_EXE_ash-app-server"))
            .args([
                "--listen",
                "ws://127.0.0.1:0",
                "--ws-auth",
                "capability-token",
                "--ws-token-sha256",
                &format!("{digest:x}"),
                "--emit-listen-info",
                "stdout-json",
            ])
            .env("ASH_HOME", profile.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (startup_sender, startup_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = startup_sender.send(result);
    });
    let startup = startup_receiver
        .recv_timeout(STARTUP_TIMEOUT)
        .expect("App Server startup record timed out")
        .unwrap();
    assert!(!startup.contains(TOKEN));
    let listen_info: AppServerListenInfo = serde_json::from_str(startup.trim()).unwrap();
    listen_info.validate().unwrap();

    runtime().block_on(async {
        let mut request = listen_info.endpoint().into_client_request().unwrap();
        request.headers_mut().insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).unwrap(),
        );
        let address = request.uri().authority().unwrap().as_str();
        let stream = TcpStream::connect(address).await.unwrap();
        let (mut websocket, _) = client_async(request, stream).await.unwrap();
        websocket
            .send(Message::Text(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"process-test","version":"1"},"capabilities":{}}}"#
                    .into(),
            ))
            .await
            .unwrap();
        let response = websocket
            .next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], 1);
        assert!(response["result"].is_object());
        websocket.close(None).await.unwrap();
    });
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

struct ProcessGuard(Child);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
