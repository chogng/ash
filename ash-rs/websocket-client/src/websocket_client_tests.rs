use super::*;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use futures::SinkExt;
use futures::StreamExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_tungstenite::accept_async;

#[test]
fn request_rejects_http_and_url_credentials() {
    assert!(matches!(
        WebSocketRequest::new("https://example.test/v1/responses", Vec::new()),
        Err(WebSocketClientError::InvalidRequest(_))
    ));
    assert!(matches!(
        WebSocketRequest::new("wss://secret@example.test/v1/responses", Vec::new()),
        Err(WebSocketClientError::InvalidRequest(_))
    ));
}

#[test]
fn request_debug_redacts_url_and_header_values() {
    let request = WebSocketRequest::new(
        "wss://example.test/v1/responses?secret=query",
        vec![HttpHeader::new("Authorization", "Bearer secret")],
    )
    .unwrap();

    let debug = format!("{request:?}");
    assert!(!debug.contains("query"));
    assert!(!debug.contains("Bearer secret"));
}

#[tokio::test]
async fn connector_round_trips_owned_messages_over_a_local_socket() {
    let (address, server) = start_echo_server().await;
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let connector = WebSocketConnector::new(network)
        .with_config(WebSocketClientConfig::new().with_tcp_no_delay(TcpNoDelay::Enabled));
    let request =
        WebSocketRequest::new(format!("ws://{address}/v1/responses"), Vec::new()).unwrap();

    let (mut socket, handshake) = connector.connect(request).await.unwrap();
    assert_eq!(handshake.status(), 101);
    let expected = WebSocketMessage::Text("hello".into());
    socket.send(expected.clone()).await.unwrap();
    assert_eq!(socket.receive().await.unwrap(), expected);

    server.await.unwrap();
}

#[tokio::test]
async fn connector_tunnels_through_an_explicit_http_proxy() {
    let (target_address, target_server) = start_echo_server().await;
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = proxy_listener.local_addr().unwrap();
    let proxy = tokio::spawn(async move {
        let (mut client, _) = proxy_listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            client.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with(&format!("CONNECT {target_address} HTTP/1.1\r\n")));
        let mut target = TcpStream::connect(target_address).await.unwrap();
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        tokio::io::copy_bidirectional(&mut client, &mut target)
            .await
            .unwrap();
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Explicit(format!("http://{proxy_address}"))),
    )
    .unwrap();
    let connector = WebSocketConnector::new(network);
    let request =
        WebSocketRequest::new(format!("ws://{target_address}/v1/responses"), Vec::new()).unwrap();

    let (mut socket, _) = connector.connect(request).await.unwrap();
    let expected = WebSocketMessage::Text("through proxy".into());
    socket.send(expected.clone()).await.unwrap();
    assert_eq!(socket.receive().await.unwrap(), expected);
    drop(socket);

    target_server.await.unwrap();
    proxy.await.unwrap();
}

async fn start_echo_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let message = socket.next().await.unwrap().unwrap();
        socket.send(message).await.unwrap();
    });
    (address, server)
}

#[test]
fn handshake_rejects_header_injection_and_transport_owned_overrides() {
    for header in [
        HttpHeader::new("X-Test", "private\r\nInjected: private"),
        HttpHeader::new("Sec-WebSocket-Key", "private"),
        HttpHeader::new("Host", "private"),
    ] {
        let error = WebSocketRequest::new("wss://example.test", vec![header]).unwrap_err();
        assert!(!error.to_string().contains("private"));
    }
}

#[tokio::test]
async fn rejected_handshake_preserves_status_without_response_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let _ = stream.read(&mut bytes).await.unwrap();
        stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 14\r\nConnection: close\r\n\r\nprivate-secret").await.unwrap();
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let result = WebSocketConnector::new(network)
        .connect(WebSocketRequest::new(format!("ws://{address}"), vec![]).unwrap())
        .await;
    let Err(error) = result else {
        panic!("handshake must fail");
    };
    assert_eq!(error, WebSocketClientError::HandshakeRejected(401));
    assert!(!error.to_string().contains("private"));
    server.await.unwrap();
}
