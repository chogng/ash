use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddr;

use futures::SinkExt;
use futures::StreamExt;
use sha2::Digest;
use sha2::Sha256;
use tokio::net::TcpStream;
use tokio_tungstenite::client_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::StatusCode;

use super::CapabilityTokenSha256;
use super::parse_loopback_websocket_bind;
use super::start_websocket_acceptor;

const TOKEN: &str = "test-only-high-entropy-capability-token";

#[test]
fn bind_address_requires_a_numeric_loopback_websocket_url() {
    assert_eq!(
        parse_loopback_websocket_bind("ws://127.0.0.1:0").unwrap(),
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0))
    );
    assert!(parse_loopback_websocket_bind("ws://192.0.2.1:0").is_err());
    assert!(parse_loopback_websocket_bind("http://127.0.0.1:0").is_err());
    assert!(parse_loopback_websocket_bind("ws://localhost:0").is_err());
}

#[test]
fn listener_authenticates_and_isolates_connections() {
    runtime().block_on(async {
        let listener = start_websocket_acceptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            token_digest(),
            |reader, mut writer| {
                let mut reader = BufReader::new(reader);
                loop {
                    let mut request = String::new();
                    match reader.read_line(&mut request) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            writer.write_all(request.as_bytes()).unwrap();
                            writer.flush().unwrap();
                        }
                    }
                }
            },
        )
        .await
        .unwrap();
        let address = listener.address();

        let unauthorized = connect(address, None).await.unwrap_err();
        assert!(matches!(
            unauthorized,
            tokio_tungstenite::tungstenite::Error::Http(response)
                if response.status() == StatusCode::UNAUTHORIZED
        ));
        let with_origin = connect_with_headers(address, Some(TOKEN), Some("https://example.test"))
            .await
            .unwrap_err();
        assert!(matches!(
            with_origin,
            tokio_tungstenite::tungstenite::Error::Http(response)
                if response.status() == StatusCode::FORBIDDEN
        ));
        let wrong_path = connect_endpoint(format!("ws://{address}/rpc"), Some(TOKEN), None)
            .await
            .unwrap_err();
        assert!(matches!(
            wrong_path,
            tokio_tungstenite::tungstenite::Error::Http(response)
                if response.status() == StatusCode::NOT_FOUND
        ));

        let mut first = connect(address, Some(TOKEN)).await.unwrap();
        let mut second = connect(address, Some(TOKEN)).await.unwrap();
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        first.send(Message::Text(request.into())).await.unwrap();
        second.send(Message::Text(request.into())).await.unwrap();
        assert_eq!(
            first.next().await.unwrap().unwrap().into_text().unwrap(),
            request
        );
        assert_eq!(
            second.next().await.unwrap().unwrap().into_text().unwrap(),
            request
        );

        listener.shutdown().await.unwrap();
    });
}

#[test]
fn a_backpressured_connection_preserves_frames_and_does_not_block_another_connection() {
    runtime().block_on(async {
        let listener = start_websocket_acceptor(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            token_digest(),
            |reader, mut writer| {
                let mut reader = BufReader::new(reader);
                loop {
                    let mut request = String::new();
                    match reader.read_line(&mut request) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if request.trim() == "slow" => {
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        Ok(_) => {
                            writer.write_all(request.as_bytes()).unwrap();
                            writer.flush().unwrap();
                        }
                    }
                }
            },
        )
        .await
        .unwrap();
        let address = listener.address();
        let mut slow = connect(address, Some(TOKEN)).await.unwrap();
        let mut healthy = connect(address, Some(TOKEN)).await.unwrap();

        for _ in 0..4 {
            slow.send(Message::Text("slow".into())).await.unwrap();
        }
        healthy.send(Message::Text("healthy".into())).await.unwrap();
        assert_eq!(
            healthy.next().await.unwrap().unwrap().into_text().unwrap(),
            "healthy"
        );
        slow.send(Message::Text("resumed".into())).await.unwrap();
        let resumed = tokio::time::timeout(std::time::Duration::from_secs(2), slow.next())
            .await
            .expect("backpressured connection did not resume");
        assert_eq!(resumed.unwrap().unwrap().into_text().unwrap(), "resumed");

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
    let digest = Sha256::digest(TOKEN.as_bytes());
    CapabilityTokenSha256::from_hex(&format!("{digest:x}")).unwrap()
}

async fn connect(
    address: SocketAddr,
    token: Option<&str>,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>, tokio_tungstenite::tungstenite::Error> {
    connect_with_headers(address, token, None).await
}

async fn connect_with_headers(
    address: SocketAddr,
    token: Option<&str>,
    origin: Option<&str>,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>, tokio_tungstenite::tungstenite::Error> {
    connect_endpoint(format!("ws://{address}"), token, origin).await
}

async fn connect_endpoint(
    endpoint: String,
    token: Option<&str>,
    origin: Option<&str>,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>, tokio_tungstenite::tungstenite::Error> {
    let mut request = endpoint.into_client_request().unwrap();
    if let Some(token) = token {
        request.headers_mut().insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
    }
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_str(origin).unwrap());
    }
    let address = request.uri().authority().unwrap().as_str();
    let stream = TcpStream::connect(address).await.unwrap();
    client_async(request, stream)
        .await
        .map(|(websocket, _)| websocket)
}
