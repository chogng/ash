use super::Command;
use super::GrantSource;
use super::StartupOptions;
use super::WebSocketOptions;
use super::open_server;
use super::parse_arguments;
use ash_app_server_transport::CapabilityTokenSha256;
use ash_app_server_transport::start_websocket_acceptor;
use futures::SinkExt;
use futures::StreamExt;
use sha2::Digest;
use sha2::Sha256;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_tungstenite::client_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

const TOKEN_DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn app_server_accepts_listening_and_rejects_daemon_management() {
    assert_eq!(
        parse_arguments(&["--listen".into(), "stdio://".into()]).unwrap(),
        (Command::Stdio, None)
    );
    assert!(parse_arguments(&["connect".into()]).is_err());
    assert!(parse_arguments(&["daemon".into(), "start".into()]).is_err());
}

#[test]
fn websocket_command_requires_loopback_token_auth_and_startup_record() {
    assert_eq!(
        parse_arguments(&[
            "--listen".into(),
            "ws://127.0.0.1:0".into(),
            "--ws-auth".into(),
            "capability-token".into(),
            "--ws-token-sha256".into(),
            TOKEN_DIGEST.into(),
            "--emit-listen-info".into(),
            "stdout-json".into(),
        ])
        .unwrap(),
        (
            Command::WebSocket(WebSocketOptions {
                bind_address: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                token_sha256: CapabilityTokenSha256::from_hex(TOKEN_DIGEST).unwrap(),
            }),
            None,
        )
    );

    assert!(
        parse_arguments(&[
            "--listen".into(),
            "ws://0.0.0.0:0".into(),
            "--ws-auth".into(),
            "capability-token".into(),
            "--ws-token-sha256".into(),
            TOKEN_DIGEST.into(),
            "--emit-listen-info".into(),
            "stdout-json".into(),
        ])
        .is_err()
    );
}

#[test]
fn websocket_connections_initialize_and_close_independently() {
    let profile = tempfile::tempdir().unwrap();
    let options = StartupOptions::new(profile.path(), None, GrantSource::HostConfiguration, None);
    let server = Arc::new(open_server(&options).unwrap());
    runtime().block_on(async move {
        let connection_server = Arc::clone(&server);
        let listener = start_websocket_acceptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            token_digest(),
            move |reader, writer| {
                let _ = connection_server
                    .serve_product_host_jsonl(std::io::BufReader::new(reader), writer);
            },
        )
        .await
        .unwrap();
        let address = listener.address();
        let mut first = connect(address).await;
        let mut second = connect(address).await;
        let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"},"capabilities":{}}}"#;

        first.send(Message::Text(initialize.into())).await.unwrap();
        second.send(Message::Text(initialize.into())).await.unwrap();
        assert_initialize_response(first.next().await.unwrap().unwrap());
        assert_initialize_response(second.next().await.unwrap().unwrap());

        first.close(None).await.unwrap();
        let list = r#"{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}"#;
        second.send(Message::Text(list.into())).await.unwrap();
        let response = second.next().await.unwrap().unwrap().into_text().unwrap();
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], 2);
        assert!(response["result"].is_object());

        listener.shutdown().await.unwrap();
    });
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn token_digest() -> CapabilityTokenSha256 {
    let digest = Sha256::digest(b"app-server-websocket-test-token");
    CapabilityTokenSha256::from_hex(&format!("{digest:x}")).unwrap()
}

async fn connect(address: SocketAddr) -> tokio_tungstenite::WebSocketStream<TcpStream> {
    let mut request = format!("ws://{address}").into_client_request().unwrap();
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_static("Bearer app-server-websocket-test-token"),
    );
    let stream = TcpStream::connect(address).await.unwrap();
    client_async(request, stream).await.unwrap().0
}

fn assert_initialize_response(message: Message) {
    let response = message.into_text().unwrap();
    let response: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["id"], 1);
    assert!(response["result"].is_object());
}
