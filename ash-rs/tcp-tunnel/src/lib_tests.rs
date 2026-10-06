use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_utils::CancellationSource;
use bytes::Buf;
use bytes::Bytes;
use http::HeaderMap;
use http::Response;
use http::StatusCode;
use http::header;
use pretty_assertions::assert_eq;
use rustls::RootCertStore;
use rustls::pki_types::PrivatePkcs8KeyDer;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::task::JoinSet;
use tokio::time::timeout;
use url::Url;

use super::ConnectTarget;
use super::ConnectionState;
use super::Credentials;
use super::Error;
use super::ForwardEvent;
use super::ProxyClient;
use super::ProxyConfig;
use super::TunnelStream;

const DEADLINE: Duration = Duration::from_secs(5);

async fn wait<T>(future: impl Future<Output = T>) -> T {
    timeout(DEADLINE, future)
        .await
        .expect("test operation timed out")
}

fn credentials(token: &str, mode: &str) -> Credentials {
    let mut headers = HeaderMap::new();
    headers.insert("x-test-mode", mode.parse().unwrap());
    Credentials::bearer(token, headers).unwrap()
}

#[test]
fn typed_configuration_validates_origins_targets_and_sensitive_headers() {
    let proxy = Url::parse("https://proxy.example").unwrap();
    let cert = rcgen::generate_simple_self_signed(vec!["proxy.example".into()]).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(cert.cert.der().clone()).unwrap();
    assert!(ProxyConfig::new(proxy.clone(), std::slice::from_ref(&proxy), roots.clone()).is_ok());
    assert!(matches!(
        ProxyConfig::new(proxy.clone(), &[], roots.clone()),
        Err(Error::UntrustedProxy)
    ));
    for url in [
        "http://proxy.example",
        "https://user@proxy.example",
        "https://proxy.example/path",
        "https://proxy.example?secret",
        "https://proxy.example#secret",
        "https://proxy.example:0",
    ] {
        let url = Url::parse(url).unwrap();
        assert!(matches!(
            ProxyConfig::new(url.clone(), &[url], roots.clone()),
            Err(Error::InvalidInput(_))
        ));
    }
    assert!(
        ProxyConfig::new(
            proxy.clone(),
            std::slice::from_ref(&proxy),
            RootCertStore::empty()
        )
        .is_err()
    );
    assert!(
        ProxyConfig::new(proxy.clone(), std::slice::from_ref(&proxy), roots)
            .unwrap()
            .with_timeouts(Duration::ZERO, DEADLINE)
            .is_err()
    );
    for target in ["127.0.0.1:22", "[::1]:22", "target.example:443"] {
        assert_eq!(ConnectTarget::parse(target).unwrap().0.as_str(), target);
    }
    for target in [
        "",
        "target.example",
        "host:0",
        "user@host:22",
        "host:65536",
        "host:22/path",
    ] {
        assert!(ConnectTarget::parse(target).is_err(), "{target}");
    }
    for token in [
        "",
        "=",
        "private secret",
        "private\nsecret",
        "private\0secret",
        "a=b",
    ] {
        let error = Credentials::bearer(token, HeaderMap::new()).err().unwrap();
        assert!(!format!("{error:?} {error}").contains("private"));
    }
    assert!(Credentials::bearer(&"a".repeat(64 * 1024 + 1), HeaderMap::new()).is_err());
    for name in [
        "authorization",
        "proxy-authorization",
        "host",
        "x-forwarded-for",
        "x-real-ip",
    ] {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HeaderName::from_static(name),
            "secret".parse().unwrap(),
        );
        assert!(Credentials::bearer("token", headers).is_err(), "{name}");
    }
    let mut duplicates = HeaderMap::new();
    duplicates.append("x-route", "one".parse().unwrap());
    duplicates.append("x-route", "two".parse().unwrap());
    assert!(Credentials::bearer("token", duplicates).is_err());
    let mut headers = HeaderMap::new();
    headers.insert("x-route", "private-route".parse().unwrap());
    let valid = Credentials::bearer("private-token==", headers).unwrap();
    assert!(valid.headers[header::AUTHORIZATION].is_sensitive());
    assert!(valid.headers["x-route"].is_sensitive());
    assert_eq!(format!("{valid:?}"), "Credentials([redacted])");
    let mut headers = HeaderMap::new();
    headers.insert("x-route", "a".repeat(4097).parse().unwrap());
    assert!(Credentials::bearer("token", headers).is_err());
    let mut headers = HeaderMap::new();
    for index in 0..17 {
        headers.insert(
            header::HeaderName::from_bytes(format!("x-{index}").as_bytes()).unwrap(),
            "a".parse().unwrap(),
        );
    }
    assert!(Credentials::bearer("token", headers).is_err());
    let mut headers = HeaderMap::new();
    for index in 0..5 {
        headers.insert(
            header::HeaderName::from_bytes(format!("x-{index}").as_bytes()).unwrap(),
            "a".repeat(4096).parse().unwrap(),
        );
    }
    assert!(Credentials::bearer("token", headers).is_err());
}

struct Observed {
    authority: String,
    authorization: http::HeaderValue,
    mode: String,
}

struct Peer {
    quic: quinn::Connection,
    goaway: mpsc::Sender<oneshot::Sender<()>>,
}

struct ProxyFixture {
    endpoint: quinn::Endpoint,
    origin: Url,
    roots: RootCertStore,
    requests: mpsc::UnboundedReceiver<Observed>,
    peers: mpsc::UnboundedReceiver<Peer>,
    bodies: mpsc::UnboundedReceiver<Vec<u8>>,
    gate: Arc<Notify>,
    cancellation: CancellationSource,
    owner: JoinHandle<()>,
}

impl ProxyFixture {
    fn start() -> Self {
        let certified = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(certified.cert.der().clone()).unwrap();
        let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certified.cert.der().clone()],
            PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der()).into(),
        )
        .unwrap();
        tls.alpn_protocols = vec![b"h3".to_vec()];
        let config = quinn::ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(tls).unwrap(),
        ));
        let endpoint = quinn::Endpoint::server(config, "127.0.0.1:0".parse().unwrap()).unwrap();
        let origin = Url::parse(&format!("https://{}", endpoint.local_addr().unwrap())).unwrap();
        let (requests, observed) = mpsc::unbounded_channel();
        let (peers, connections) = mpsc::unbounded_channel();
        let (bodies, received) = mpsc::unbounded_channel();
        let gate = Arc::new(Notify::new());
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let server_endpoint = endpoint.clone();
        let server_gate = gate.clone();
        let owner = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    result = connections.join_next(), if !connections.is_empty() => { result.unwrap().unwrap(); },
                    incoming = server_endpoint.accept() => {
                        let Some(incoming) = incoming else { break };
                        let peers = peers.clone();
                        let requests = requests.clone();
                        let bodies = bodies.clone();
                        let gate = server_gate.clone();
                        let token = token.clone();
                        connections.spawn(async move {
                            let quic = tokio::select! {
                                _ = token.cancelled() => return,
                                result = incoming => match result { Ok(quic) => quic, Err(_) => return },
                            };
                            let (goaway, mut shutdown) = mpsc::channel::<oneshot::Sender<()>>(1);
                            peers.send(Peer { quic: quic.clone(), goaway }).unwrap();
                            let mut http = h3::server::builder().build(h3_quinn::Connection::new(quic)).await.unwrap();
                            let mut streams = JoinSet::new();
                            loop {
                                tokio::select! {
                                    _ = token.cancelled() => break,
                                    result = streams.join_next(), if !streams.is_empty() => { result.unwrap().unwrap(); },
                                    Some(done) = shutdown.recv() => {
                                        http.shutdown(0).await.unwrap();
                                        let _ = done.send(());
                                    }
                                    request = http.accept() => {
                                        let Ok(Some(request)) = request else { break };
                                        let (request, mut stream) = request.resolve_request().await.unwrap();
                                        assert_eq!(request.method(), http::Method::CONNECT);
                                        assert!(request.uri().scheme().is_none());
                                        assert!(request.uri().path_and_query().is_none());
                                        let authority = request.uri().authority().unwrap().as_str().to_string();
                                        let authorization = request.headers()[header::AUTHORIZATION].clone();
                                        let mode = request.headers()["x-test-mode"].to_str().unwrap().to_string();
                                        requests.send(Observed { authority: authority.clone(), authorization, mode: mode.clone() }).unwrap();
                                        let gate = gate.clone();
                                        let bodies = bodies.clone();
                                        streams.spawn(async move {
                                            if mode == "stall" {
                                                tokio::select! {
                                                    _ = gate.notified() => {},
                                                    _ = stream.recv_data() => {
                                                        let _ = bodies.send(b"cancelled-stall".to_vec());
                                                        return;
                                                    },
                                                }
                                            }
                                            if mode == "informational" {
                                                stream.send_response(Response::builder().status(103).body(()).unwrap()).await.unwrap();
                                            }
                                            if mode == "reject" {
                                                let _ = stream.send_response(Response::builder().status(403).body(()).unwrap()).await;
                                                let _ = stream.finish().await;
                                                return;
                                            }
                                            if mode == "flood" {
                                                stream.send_response(Response::builder().status(200).body(()).unwrap()).await.unwrap();
                                                let chunk = Bytes::from(vec![42; 64 * 1024]);
                                                for _ in 0..4 { stream.send_data(chunk.clone()).await.unwrap(); }
                                                bodies.send(b"flood-started".to_vec()).unwrap();
                                                while stream.send_data(chunk.clone()).await.is_ok() {}
                                                return;
                                            }
                                            if mode == "download-fin" {
                                                stream.send_response(Response::builder().status(200).body(()).unwrap()).await.unwrap();
                                                let (mut send, mut recv) = stream.split();
                                                send.finish().await.unwrap();
                                                let mut body = Vec::new();
                                                while let Ok(Some(mut data)) = recv.recv_data().await {
                                                    body.extend_from_slice(&data.copy_to_bytes(data.remaining()));
                                                }
                                                bodies.send(body).unwrap();
                                                return;
                                            }
                                            let Ok(mut socket) = TcpStream::connect(&authority).await else {
                                                let _ = stream.send_response(Response::builder().status(502).body(()).unwrap()).await;
                                                let _ = stream.finish().await;
                                                return;
                                            };
                                            if stream.send_response(Response::builder().status(200).body(()).unwrap()).await.is_err() { return; }
                                            let (mut send, mut recv) = stream.split();
                                            let (mut read, mut write) = socket.split();
                                            let upload = async {
                                                while let Some(mut data) = recv.recv_data().await? {
                                                    let size = data.remaining();
                                                    write.write_all(&data.copy_to_bytes(size)).await?;
                                                }
                                                write.shutdown().await?;
                                                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
                                            };
                                            let download = async {
                                                let mut buffer = vec![0; 8192];
                                                loop {
                                                    let size = read.read(&mut buffer).await?;
                                                    if size == 0 { break; }
                                                    send.send_data(Bytes::copy_from_slice(&buffer[..size])).await?;
                                                }
                                                send.finish().await?;
                                                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
                                            };
                                            let _ = tokio::try_join!(upload, download);
                                        });
                                    }
                                }
                            }
                            streams.abort_all();
                            while let Some(result) = streams.join_next().await {
                                if !result.as_ref().is_err_and(tokio::task::JoinError::is_cancelled) { result.unwrap(); }
                            }
                        });
                    }
                }
            }
            server_endpoint.close(0_u8.into(), b"fixture closed");
            while let Some(result) = connections.join_next().await {
                result.unwrap();
            }
        });
        Self {
            endpoint,
            origin,
            roots,
            requests: observed,
            peers: connections,
            bodies: received,
            gate,
            cancellation,
            owner,
        }
    }

    fn config(&self) -> ProxyConfig {
        ProxyConfig::new(
            self.origin.clone(),
            std::slice::from_ref(&self.origin),
            self.roots.clone(),
        )
        .unwrap()
    }

    async fn client(&self) -> ProxyClient {
        wait(ProxyClient::connect(
            self.config(),
            credentials("initial", "normal"),
            CancellationSource::new().token(),
        ))
        .await
        .unwrap()
    }

    async fn close(mut self) {
        self.cancellation.cancel();
        wait(&mut self.owner).await.unwrap();
    }
}

impl Drop for ProxyFixture {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.endpoint.close(0_u8.into(), b"fixture dropped");
    }
}

struct EchoTarget {
    address: std::net::SocketAddr,
    cancellation: CancellationSource,
    owner: JoinHandle<()>,
}

impl EchoTarget {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let owner = tokio::spawn(async move {
            let mut sockets = JoinSet::new();
            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    result = sockets.join_next(), if !sockets.is_empty() => { result.unwrap().unwrap(); },
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        sockets.spawn(async move {
                            let mut buffer = [0; 8192];
                            while let Ok(size) = socket.read(&mut buffer).await {
                                if size == 0 { break; }
                                if socket.write_all(&buffer[..size]).await.is_err() { return; }
                            }
                            let _ = socket.shutdown().await;
                        });
                    }
                }
            }
            sockets.abort_all();
            while sockets.join_next().await.is_some() {}
        });
        Self {
            address,
            cancellation,
            owner,
        }
    }

    fn target(&self) -> ConnectTarget {
        ConnectTarget::parse(&self.address.to_string()).unwrap()
    }

    async fn close(mut self) {
        self.cancellation.cancel();
        wait(&mut self.owner).await.unwrap();
    }
}

impl Drop for EchoTarget {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

async fn roundtrip(
    stream: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin),
    payload: &[u8],
) {
    let (mut read, mut write) = tokio::io::split(stream);
    let upload = async {
        write.write_all(payload).await.unwrap();
        write.shutdown().await.unwrap();
    };
    let download = async {
        let mut received = Vec::new();
        read.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, payload);
    };
    wait(async {
        tokio::join!(upload, download);
    })
    .await;
}

async fn open(client: &ProxyClient, target: &EchoTarget) -> TunnelStream {
    wait(client.open_stream(target.target(), CancellationSource::new().token()))
        .await
        .unwrap()
}

#[tokio::test]
async fn streams_multiplex_credentials_and_large_transfers_with_upload_fin() {
    let mut proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let client = proxy.client().await;
    let mut first = open(&client, &target).await;
    let initial = wait(proxy.requests.recv()).await.unwrap();
    assert_eq!(initial.authority, target.address.to_string());
    assert_eq!(initial.authorization, "Bearer initial");
    client
        .update_credentials(credentials("refreshed", "normal"))
        .unwrap();
    let mut second = open(&client, &target).await;
    let updated = wait(proxy.requests.recv()).await.unwrap();
    assert_eq!(updated.authorization, "Bearer refreshed");
    let large: Vec<_> = (0..1024 * 1024).map(|index| (index % 251) as u8).collect();
    tokio::join!(
        roundtrip(&mut first, &large),
        roundtrip(&mut second, b"independent-stream")
    );
    assert_eq!(client.state(), ConnectionState::Connected);
    assert!(proxy.requests.try_recv().is_err());
    assert!(proxy.peers.try_recv().is_ok());
    assert!(proxy.peers.try_recv().is_err());
    wait(first.close()).await.unwrap();
    wait(second.close()).await.unwrap();
    wait(client.close()).await.unwrap();
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn connect_success_gates_streams_and_rejection_is_typed() {
    let mut proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let client = proxy.client().await;
    client
        .update_credentials(credentials("token", "stall"))
        .unwrap();
    let mut pending =
        Box::pin(client.open_stream(target.target(), CancellationSource::new().token()));
    tokio::select! {
        _ = &mut pending => panic!("CONNECT returned before a response"),
        request = proxy.requests.recv() => assert_eq!(request.unwrap().mode, "stall"),
    }
    assert!(
        timeout(Duration::from_millis(25), &mut pending)
            .await
            .is_err()
    );
    proxy.gate.notify_one();
    let mut stream = wait(pending).await.unwrap();
    roundtrip(&mut stream, b"after-2xx").await;
    wait(stream.close()).await.unwrap();
    client
        .update_credentials(credentials("token", "reject"))
        .unwrap();
    assert_eq!(
        client
            .open_stream(target.target(), CancellationSource::new().token())
            .await
            .err(),
        Some(Error::Rejected(StatusCode::FORBIDDEN))
    );
    assert_eq!(client.state(), ConnectionState::Connected);
    client
        .update_credentials(credentials("token", "informational"))
        .unwrap();
    let mut sibling = open(&client, &target).await;
    roundtrip(&mut sibling, b"rejection-is-isolated").await;
    wait(sibling.close()).await.unwrap();
    wait(client.close()).await.unwrap();
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn download_fin_keeps_upload_direction_open() {
    let mut proxy = ProxyFixture::start();
    let client = proxy.client().await;
    client
        .update_credentials(credentials("token", "download-fin"))
        .unwrap();
    let mut stream = wait(client.open_stream(
        ConnectTarget::parse("target.example:22").unwrap(),
        CancellationSource::new().token(),
    ))
    .await
    .unwrap();
    let mut byte = [0];
    assert_eq!(wait(stream.read(&mut byte)).await.unwrap(), 0);
    stream
        .write_all(b"upload-after-download-fin")
        .await
        .unwrap();
    stream.shutdown().await.unwrap();
    assert_eq!(
        wait(proxy.bodies.recv()).await.unwrap(),
        b"upload-after-download-fin"
    );
    wait(stream.close()).await.unwrap();
    wait(client.close()).await.unwrap();
    proxy.close().await;
}

#[tokio::test]
async fn handshake_and_connect_cancellation_and_timeouts_release_work() {
    let mut proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let silent = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let origin = Url::parse(&format!("https://{}", silent.local_addr().unwrap())).unwrap();
    let config = ProxyConfig::new(origin.clone(), &[origin], proxy.roots.clone()).unwrap();
    let cancellation = CancellationSource::new();
    let mut connecting = Box::pin(ProxyClient::connect(
        config,
        credentials("token", "normal"),
        cancellation.token(),
    ));
    let mut packet = [0; 1500];
    tokio::select! {
        _ = &mut connecting => panic!("silent peer completed TLS"),
        result = silent.recv_from(&mut packet) => { result.unwrap(); },
    }
    cancellation.cancel();
    assert_eq!(wait(connecting).await.err(), Some(Error::Cancelled));
    let origin = Url::parse(&format!("https://{}", silent.local_addr().unwrap())).unwrap();
    let config = ProxyConfig::new(origin.clone(), &[origin], proxy.roots.clone())
        .unwrap()
        .with_timeouts(Duration::from_millis(50), DEADLINE)
        .unwrap();
    assert_eq!(
        wait(ProxyClient::connect(
            config,
            credentials("token", "normal"),
            CancellationSource::new().token()
        ))
        .await
        .err(),
        Some(Error::ConnectionTimeout)
    );

    let client = proxy.client().await;
    client
        .update_credentials(credentials("token", "stall"))
        .unwrap();
    let cancellation = CancellationSource::new();
    let mut pending = Box::pin(client.open_stream(target.target(), cancellation.token()));
    tokio::select! {
        _ = &mut pending => panic!("stalled CONNECT completed"),
        request = proxy.requests.recv() => { request.unwrap(); },
    }
    cancellation.cancel();
    assert_eq!(wait(pending).await.err(), Some(Error::Cancelled));
    assert_eq!(wait(proxy.bodies.recv()).await.unwrap(), b"cancelled-stall");
    // Dropping a future during setup also cancels its request, without ending the client.
    let mut abandoned =
        Box::pin(client.open_stream(target.target(), CancellationSource::new().token()));
    tokio::select! {
        _ = &mut abandoned => panic!("stalled CONNECT completed"),
        request = proxy.requests.recv() => { request.unwrap(); },
    }
    drop(abandoned);
    assert_eq!(wait(proxy.bodies.recv()).await.unwrap(), b"cancelled-stall");
    client
        .update_credentials(credentials("token", "normal"))
        .unwrap();
    let mut sibling = open(&client, &target).await;
    roundtrip(&mut sibling, b"client-still-usable").await;
    wait(sibling.close()).await.unwrap();
    wait(client.close()).await.unwrap();
    let config = proxy
        .config()
        .with_timeouts(DEADLINE, Duration::from_millis(50))
        .unwrap();
    let timed = wait(ProxyClient::connect(
        config,
        credentials("token", "stall"),
        CancellationSource::new().token(),
    ))
    .await
    .unwrap();
    assert_eq!(
        wait(timed.open_stream(target.target(), CancellationSource::new().token()))
            .await
            .err(),
        Some(Error::RequestTimeout)
    );
    assert_eq!(wait(proxy.bodies.recv()).await.unwrap(), b"cancelled-stall");
    wait(timed.close()).await.unwrap();
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn tls_verification_rejects_an_untrusted_certificate() {
    let proxy = ProxyFixture::start();
    let unrelated = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(unrelated.cert.der().clone()).unwrap();
    let config = ProxyConfig::new(
        proxy.origin.clone(),
        std::slice::from_ref(&proxy.origin),
        roots,
    )
    .unwrap();
    assert_eq!(
        wait(ProxyClient::connect(
            config,
            credentials("private-token", "normal"),
            CancellationSource::new().token()
        ))
        .await
        .err(),
        Some(Error::Connection)
    );
    proxy.close().await;
}

#[tokio::test]
async fn closing_owners_releases_ports_streams_and_keeps_runtime_and_siblings_alive() {
    let mut proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let client = proxy.client().await;
    let peer = wait(proxy.peers.recv()).await.unwrap();
    let sibling_client = proxy.client().await;
    let sibling_peer = wait(proxy.peers.recv()).await.unwrap();
    assert!(
        client
            .listen_loopback(target.target(), "0.0.0.0:0".parse().unwrap())
            .await
            .is_err()
    );
    let forward = client
        .listen_loopback(target.target(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = forward.local_addr();
    let other = client
        .listen_loopback(target.target(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let mut local = TcpStream::connect(address).await.unwrap();
    local.write_all(b"alive").await.unwrap();
    let mut bytes = [0; 5];
    wait(local.read_exact(&mut bytes)).await.unwrap();
    assert_eq!(bytes, *b"alive");
    wait(forward.close()).await.unwrap();
    assert!(matches!(wait(local.read(&mut bytes)).await, Ok(0) | Err(_)));
    let rebound = TcpListener::bind(address).await.unwrap();
    drop(rebound);
    assert_eq!(client.state(), ConnectionState::Connected);
    let mut second_local = TcpStream::connect(other.local_addr()).await.unwrap();
    roundtrip(&mut second_local, b"other-listener").await;
    let mut direct = open(&client, &target).await;
    wait(client.close()).await.unwrap();
    wait(peer.quic.closed()).await;
    assert!(
        wait(direct.read(&mut bytes)).await.is_err(),
        "client closure must not become a successful TCP EOF"
    );
    wait(direct.close()).await.unwrap();
    wait(other.close()).await.unwrap();
    let mut sibling = open(&sibling_client, &target).await;
    roundtrip(&mut sibling, b"runtime-and-sibling-survive").await;
    wait(sibling.close()).await.unwrap();
    let mut state = sibling_client.subscribe();
    drop(sibling_client);
    wait(state.wait_for(|state| matches!(state, ConnectionState::Closed(_))))
        .await
        .unwrap();
    wait(sibling_peer.quic.closed()).await;
    assert_eq!(wait(tokio::spawn(async { 42 })).await.unwrap(), 42);
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn loopback_failures_are_typed_and_listener_drop_releases_its_port() {
    let proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let client = proxy.client().await;
    client
        .update_credentials(credentials("token", "reject"))
        .unwrap();
    let forward = client
        .listen_loopback(target.target(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let mut events = forward.subscribe();
    let address = forward.local_addr();
    let mut socket = TcpStream::connect(address).await.unwrap();
    let mut byte = [0];
    assert!(matches!(wait(socket.read(&mut byte)).await, Ok(0) | Err(_)));
    assert_eq!(
        wait(events.recv()).await.unwrap(),
        ForwardEvent::ConnectFailed(Error::Rejected(StatusCode::FORBIDDEN))
    );
    client
        .update_credentials(credentials("token", "normal"))
        .unwrap();
    let mut socket = TcpStream::connect(address).await.unwrap();
    roundtrip(&mut socket, b"listener-survives-rejection").await;
    drop(forward);
    wait(async {
        loop {
            match TcpListener::bind(address).await {
                Ok(listener) => {
                    drop(listener);
                    break;
                }
                Err(_) => tokio::task::yield_now().await,
            }
        }
    })
    .await;
    wait(client.close()).await.unwrap();
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn goaway_drains_existing_streams_and_transport_failure_never_replays() {
    let mut proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let client = proxy.client().await;
    let peer = wait(proxy.peers.recv()).await.unwrap();
    let mut persistent = open(&client, &target).await;
    let (done, sent) = oneshot::channel();
    peer.goaway.send(done).await.unwrap();
    wait(sent).await.unwrap();
    wait(async {
        loop {
            match client
                .open_stream(target.target(), CancellationSource::new().token())
                .await
            {
                Err(Error::Draining) => break,
                Err(Error::RequestRejected) => {}
                Ok(stream) => stream.close().await.unwrap(),
                Err(error) => panic!("unexpected GOAWAY error: {error}"),
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(client.state(), ConnectionState::Draining);
    persistent.write_all(b"still-alive").await.unwrap();
    let mut bytes = [0; 11];
    wait(persistent.read_exact(&mut bytes)).await.unwrap();
    assert_eq!(bytes, *b"still-alive");
    assert!(
        proxy.peers.try_recv().is_err(),
        "low-level client must not reconnect automatically"
    );
    let replacement = proxy.client().await;
    let mut new_stream = open(&replacement, &target).await;
    roundtrip(&mut new_stream, b"explicit-new-connection").await;
    wait(new_stream.close()).await.unwrap();
    assert!(proxy.peers.try_recv().is_ok());
    peer.quic.close(0_u8.into(), b"test disconnect");
    let error = wait(persistent.read(&mut bytes)).await.unwrap_err();
    assert_eq!(
        error.get_ref().unwrap().downcast_ref::<Error>(),
        Some(&Error::Transport)
    );
    let mut state = client.subscribe();
    wait(state.wait_for(|state| matches!(state, ConnectionState::Closed(_))))
        .await
        .unwrap();
    assert_eq!(
        wait(client.open_stream(target.target(), CancellationSource::new().token()))
            .await
            .err(),
        Some(Error::Closed)
    );
    assert!(
        proxy.peers.try_recv().is_err(),
        "old transport must not reconnect or replay"
    );
    wait(persistent.close()).await.unwrap();
    wait(client.close()).await.unwrap();
    wait(replacement.close()).await.unwrap();
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn dropping_and_cancelling_streams_preserves_other_requests() {
    let proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let client = proxy.client().await;
    let dropped = open(&client, &target).await;
    drop(dropped);
    let cancellation = CancellationSource::new();
    let mut cancelled = wait(client.open_stream(target.target(), cancellation.token()))
        .await
        .unwrap();
    cancellation.cancel();
    let mut byte = [0];
    assert!(wait(cancelled.read(&mut byte)).await.is_err());
    wait(cancelled.close()).await.unwrap();
    let mut survivor = open(&client, &target).await;
    roundtrip(&mut survivor, b"sibling-stream-survives").await;
    wait(survivor.close()).await.unwrap();
    assert_eq!(client.state(), ConnectionState::Connected);
    wait(client.close()).await.unwrap();
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn closing_client_joins_a_just_created_listener_and_pending_connect() {
    let mut proxy = ProxyFixture::start();
    let target = EchoTarget::start().await;
    let parent = CancellationSource::new();
    let client = Arc::new(
        wait(ProxyClient::connect(
            proxy.config(),
            credentials("token", "normal"),
            parent.token(),
        ))
        .await
        .unwrap(),
    );
    client
        .update_credentials(credentials("token", "stall"))
        .unwrap();
    let worker_client = client.clone();
    let destination = target.target();
    let worker = tokio::spawn(async move {
        worker_client
            .open_stream(destination, CancellationSource::new().token())
            .await
            .err()
    });
    wait(proxy.requests.recv()).await.unwrap();
    let mut state = client.subscribe();
    let forward = client
        .listen_loopback(target.target(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = forward.local_addr();
    parent.cancel();
    assert_eq!(wait(worker).await.unwrap(), Some(Error::Closed));
    let client = Arc::try_unwrap(client).ok().unwrap();
    wait(client.close()).await.unwrap();
    wait(forward.close()).await.unwrap();
    let rebound = TcpListener::bind(address).await.unwrap();
    drop(rebound);
    assert!(matches!(
        *state.borrow_and_update(),
        ConnectionState::Closed(_)
    ));
    target.close().await;
    proxy.close().await;
}

#[tokio::test]
async fn close_joins_streams_stalled_on_application_backpressure() {
    let mut proxy = ProxyFixture::start();
    let client = proxy.client().await;
    client
        .update_credentials(credentials("token", "flood"))
        .unwrap();
    let stream = wait(client.open_stream(
        ConnectTarget::parse("target.example:22").unwrap(),
        CancellationSource::new().token(),
    ))
    .await
    .unwrap();
    assert_eq!(wait(proxy.bodies.recv()).await.unwrap(), b"flood-started");
    // The application never reads this continuous download. Shutdown must cancel
    // the pump even when its bounded local buffer cannot accept another byte.
    wait(client.close()).await.unwrap();
    wait(stream.close()).await.unwrap();
    assert_eq!(
        wait(tokio::spawn(async { "runtime alive" })).await.unwrap(),
        "runtime alive"
    );
    proxy.close().await;
}
