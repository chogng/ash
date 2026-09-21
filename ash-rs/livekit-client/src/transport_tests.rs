use super::*;
use ash_http_client::CertificateBundle;
use ash_http_client::HttpClientConfig;
use ash_http_client::ProxyPolicy;
use ash_http_client::TlsPolicy;
use futures::SinkExt;
use futures::StreamExt;
use livekit_net::HttpClient as _;
use livekit_net::WsClient as _;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn custom_trust_is_shared_by_http_and_websocket_and_does_not_leak_between_clients() {
    let cert = rustls::pki_types::CertificateDer::from(
        include_bytes!("../tests/fixtures/server.der").to_vec(),
    );
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(
        include_bytes!("../tests/fixtures/server-key.der").to_vec(),
    );
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert], key.into())
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        // HTTPS uses the custom CA.
        let (socket, _) = listener.accept().await.unwrap();
        let mut tls = acceptor.accept(socket).await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(tls.read_u8().await.unwrap());
        }
        tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
        tls.shutdown().await.unwrap();
        // A different client's system trust must not inherit that CA.
        let (socket, _) = listener.accept().await.unwrap();
        assert!(acceptor.accept(socket).await.is_err());
        // WSS with the custom CA supports simultaneous sends and receives.
        let (socket, _) = listener.accept().await.unwrap();
        let tls = acceptor.accept(socket).await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tls).await.unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Ping(
            vec![7].into(),
        ))
        .await
        .unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Binary(
            vec![1, 2].into(),
        ))
        .await
        .unwrap();
        let mut pong = false;
        let mut binary = false;
        while !(pong && binary) {
            match ws.next().await.unwrap().unwrap() {
                tokio_tungstenite::tungstenite::Message::Pong(value) => {
                    assert_eq!(&value[..], &[7]);
                    pong = true;
                }
                tokio_tungstenite::tungstenite::Message::Binary(value) => {
                    assert_eq!(&value[..], &[3, 4]);
                    binary = true;
                }
                other => panic!("unexpected message: {other:?}"),
            }
        }
        assert!(matches!(
            ws.next().await.unwrap().unwrap(),
            tokio_tungstenite::tungstenite::Message::Close(_)
        ));
    });
    let bundle =
        CertificateBundle::from_der(vec![include_bytes!("../tests/fixtures/ca.der").to_vec()])
            .unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(bundle));
    let trusted = client(OutboundNetworkSnapshot::new(config).unwrap()).unwrap();
    let plain = client(
        OutboundNetworkSnapshot::new(
            HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        )
        .unwrap(),
    )
    .unwrap();
    let response = trusted
        .request(
            livekit_net::HttpMethod::Get,
            format!("https://{address}/validate"),
            vec![],
            None,
        )
        .await
        .unwrap();
    assert_eq!((response.status, response.body), (200, b"ok".to_vec()));
    assert!(
        plain
            .connect(format!("wss://{address}/rtc"), vec![], 2_000)
            .await
            .is_err()
    );
    let connection = trusted
        .connect(format!("wss://{address}/rtc"), vec![], 2_000)
        .await
        .unwrap()
        .connection;
    let (sent, received) = tokio::join!(
        connection.send(vec![3, 4]),
        timeout(IO_TIMEOUT, connection.recv())
    );
    sent.unwrap();
    assert_eq!(received.unwrap().unwrap(), Some(vec![1, 2]));
    connection.close().await;
    timeout(IO_TIMEOUT, server).await.unwrap().unwrap();
}

#[test]
fn process_transport_is_registered() {
    install().unwrap();
    assert!(livekit_net::has_http_client());
    assert!(livekit_net::has_ws_client());
}
