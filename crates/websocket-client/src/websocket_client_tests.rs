use super::*;
use ash_http_client::CertificateBundle;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::NetworkAccess;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_http_client::TlsPolicy;
use base64::Engine;
use futures::SinkExt;
use futures::StreamExt;
use rustls::pki_types::PrivatePkcs8KeyDer;
use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;
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
async fn live_socket_ends_when_its_host_is_revoked() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _socket = accept_async(stream).await.unwrap();
        std::future::pending::<()>().await;
    });
    let policy = OutboundNetworkPolicy::new(NetworkAccess::Hosts(BTreeSet::from([
        "127.0.0.1".to_owned()
    ])));
    let network = OutboundNetworkSnapshot::with_policy(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        policy.clone(),
    )
    .unwrap();
    let request = WebSocketRequest::new(format!("ws://{address}/events"), Vec::new()).unwrap();
    let (mut socket, _) = WebSocketConnector::new(network)
        .connect(request)
        .await
        .unwrap();

    policy.update(NetworkAccess::Hosts(BTreeSet::new()));
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), socket.receive())
        .await
        .unwrap();
    assert_eq!(result.unwrap_err(), WebSocketClientError::ConnectionClosed);
    assert_eq!(
        socket.send(WebSocketMessage::Text("late".into())).await,
        Err(WebSocketClientError::ConnectionClosed)
    );
    server.abort();
}

#[tokio::test]
async fn connector_tunnels_through_an_http_proxy_with_url_encoded_credentials() {
    let (target_address, target_server) = start_echo_server().await;
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_address = proxy_listener.local_addr().unwrap();
    let proxy = tokio::spawn(async move {
        let (mut client, _) = proxy_listener.accept().await.unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode("user@example:p@ss:%2F+雪");
        accept_connect(
            &mut client,
            target_address,
            Some(&format!("Basic {encoded}")),
        )
        .await;
        let mut target = TcpStream::connect(target_address).await.unwrap();
        tokio::io::copy_bidirectional(&mut client, &mut target)
            .await
            .unwrap();
    });
    let network = OutboundNetworkSnapshot::new(HttpClientConfig::new().with_proxy_policy(
        ProxyPolicy::Explicit(format!(
            "http://user%40example:p%40ss%3A%252F+%E9%9B%AA@{proxy_address}"
        )),
    ))
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

#[tokio::test]
async fn connector_tunnels_secure_ipv6_websocket_through_an_ipv6_https_proxy() {
    let target_address = "[2001:db8::1]:443".parse::<SocketAddr>().unwrap();
    let proxy_listener = TcpListener::bind("[::1]:0").await.unwrap();
    let proxy_address = proxy_listener.local_addr().unwrap();
    let certified =
        rcgen::generate_simple_self_signed(vec!["::1".into(), "2001:db8::1".into()]).unwrap();
    let certificate = certified.cert.der();
    let roots = CertificateBundle::from_der(vec![certificate.to_vec()]).unwrap();
    let tls = rustls::ServerConfig::builder_with_provider(
        rustls::crypto::aws_lc_rs::default_provider().into(),
    )
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![certificate.clone()],
        PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()).into(),
    )
    .unwrap();
    let tls = TlsAcceptor::from(Arc::new(tls));
    let proxy = tokio::spawn(async move {
        let (client, _) = proxy_listener.accept().await.unwrap();
        let mut client = tls.accept(client).await.unwrap();
        accept_connect(&mut client, target_address, None).await;
        // Act as the origin inside the tunnel without dialing its documentation address.
        echo_message(tls.accept(client).await.unwrap()).await;
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Explicit(format!("https://{proxy_address}")))
            .with_tls_policy(TlsPolicy::CustomOnly(roots)),
    )
    .unwrap();
    let request =
        WebSocketRequest::new(format!("wss://{target_address}/events"), Vec::new()).unwrap();

    let (mut socket, _) = WebSocketConnector::new(network)
        .connect(request)
        .await
        .unwrap();
    let expected = WebSocketMessage::Text("through IPv6 proxy".into());
    socket.send(expected.clone()).await.unwrap();
    assert_eq!(socket.receive().await.unwrap(), expected);

    proxy.await.unwrap();
}

async fn accept_connect(
    client: &mut (impl AsyncRead + AsyncWrite + Unpin),
    target_address: SocketAddr,
    expected_authorization: Option<&str>,
) {
    let mut request = Vec::new();
    let mut byte = [0u8; 1];
    while !request.ends_with(b"\r\n\r\n") {
        client.read_exact(&mut byte).await.unwrap();
        request.push(byte[0]);
    }
    let request = String::from_utf8(request).unwrap();
    assert!(request.starts_with(&format!("CONNECT {target_address} HTTP/1.1\r\n")));
    let host_header = format!("Host: {target_address}");
    assert!(request.lines().any(|line| line == host_header));
    let authorization = request
        .lines()
        .find_map(|line| line.strip_prefix("Proxy-Authorization: "));
    assert_eq!(authorization, expected_authorization);
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .unwrap();
    client.flush().await.unwrap();
}

async fn start_echo_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        echo_message(stream).await;
    });
    (address, server)
}

async fn echo_message(stream: impl AsyncRead + AsyncWrite + Unpin) {
    let mut socket = accept_async(stream).await.unwrap();
    let message = socket.next().await.unwrap().unwrap();
    socket.send(message).await.unwrap();
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
