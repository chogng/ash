use crate::AshClient;
use crate::BackoffPolicy;
use crate::ClientError;
use crate::ClientRequest;
use crate::OperationClient;
use crate::RetryPolicy;
use crate::RetrySafety;
use ash_async_utils::CancellationSource;
use ash_http_client::CertificateBundle;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpMethod;
use ash_http_client::NetworkAccess;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::ProxyPolicy;
use ash_http_client::ReqwestHttpClient;
use ash_http_client::Timeout;
use ash_http_client::TlsPolicy;
use ash_http_client::TransportTimeouts;
use ash_http_client::UreqHttpClient;
use http_test_support::CA_DER;
use http_test_support::Server;
use http_test_support::response;
use std::collections::BTreeSet;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::num::NonZeroU8;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);

fn client() -> AshClient {
    let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(ca))
        .with_timeouts(TransportTimeouts::new(
            Timeout::After(WAIT),
            Timeout::After(WAIT),
            Timeout::After(WAIT),
            Timeout::After(WAIT),
        ));
    AshClient::new(Arc::new(UreqHttpClient::with_config(config).unwrap()))
}

fn write_request(server: &Server) -> ClientRequest {
    ClientRequest::post(
        format!("{}/write", server.url()),
        Vec::new(),
        b"payload".to_vec(),
        RetryPolicy::never(),
    )
    .unwrap()
}

#[test]
fn idempotent_request_retries_a_retryable_http_status() {
    let mut replies = [response(503, "retry"), response(200, "ok")].into_iter();
    let server = Server::start(move |stream| {
        stream
            .write_all(&replies.next().expect("unexpected extra attempt"))
            .unwrap();
    });
    let request = ClientRequest::new(
        HttpMethod::Get,
        format!("{}/catalog", server.url()),
        Vec::new(),
        Vec::new(),
        RetryPolicy::replayable(
            RetrySafety::Idempotent,
            NonZeroU8::new(2).unwrap(),
            BackoffPolicy::new(Duration::ZERO, Duration::ZERO),
        ),
    )
    .unwrap();
    let result = client().execute(&request).unwrap();
    assert_eq!(result.status(), 200);
    assert_eq!(result.body(), b"ok");
    for _ in 0..2 {
        assert_eq!(server.request().line, "GET /catalog HTTP/1.1");
    }
    server.assert_no_more_requests();
}

#[test]
fn cancellation_stops_waiting_for_a_dispatched_write_before_the_server_finishes() {
    let (release, released) = mpsc::channel();
    let server = Server::start(move |_stream| {
        let _ = released.recv_timeout(WAIT);
    });
    let transport = client();
    let request = write_request(&server);
    let source = CancellationSource::new();
    thread::scope(|scope| {
        let (done, completed) = mpsc::channel();
        let token = source.token();
        scope.spawn(move || {
            done.send(transport.execute_with_cancellation(&request, &token))
                .unwrap();
        });
        assert_eq!(server.request().body, b"payload");
        source.cancel();
        let result = completed.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        assert!(matches!(result.unwrap(), Err(ClientError::Cancelled(_))));
    });
    server.assert_no_more_requests();
}

#[test]
fn cancellation_stops_the_model_http_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (began, started) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\npartial")
            .unwrap();
        began.send(()).unwrap();
        match stream.read(&mut request) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("model HTTP socket stayed open after cancellation: {other:?}"),
        }
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let client = AshClient::new(Arc::new(ReqwestHttpClient::with_network(network).unwrap()));
    let request = ClientRequest::new(
        HttpMethod::Get,
        format!("http://{address}/model"),
        Vec::new(),
        Vec::new(),
        RetryPolicy::never(),
    )
    .unwrap();
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let (done, completed) = mpsc::channel();
    let caller = thread::spawn(move || {
        done.send(client.execute_with_cancellation(&request, &token))
            .unwrap();
    });
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    cancellation.cancel();
    assert!(matches!(
        completed.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(ClientError::Cancelled(_))
    ));
    caller.join().unwrap();
    server.join().unwrap();
}

#[test]
fn policy_revocation_stops_model_http_and_does_not_retry() {
    let (release, released) = mpsc::channel();
    let (began, started) = mpsc::channel();
    let server = Server::start(move |stream| {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
            .unwrap();
        stream.flush().unwrap();
        began.send(()).unwrap();
        let _ = released.recv_timeout(WAIT);
    });
    let policy = OutboundNetworkPolicy::new(NetworkAccess::Hosts(BTreeSet::from([
        "127.0.0.1".to_owned()
    ])));
    let roots = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let network = OutboundNetworkSnapshot::with_policy(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(TlsPolicy::CustomOnly(roots)),
        policy.clone(),
    )
    .unwrap();
    let client = AshClient::new(Arc::new(ReqwestHttpClient::with_network(network).unwrap()));
    let request = ClientRequest::new(
        HttpMethod::Get,
        format!("{}/model", server.url()),
        Vec::new(),
        Vec::new(),
        RetryPolicy::replayable(
            RetrySafety::Idempotent,
            NonZeroU8::new(2).unwrap(),
            BackoffPolicy::new(Duration::ZERO, Duration::ZERO),
        ),
    )
    .unwrap();
    let (done, completed) = mpsc::channel();
    let caller = thread::spawn(move || done.send(client.execute(&request)).unwrap());
    assert_eq!(server.request().line, "GET /model HTTP/1.1");
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    policy.update(NetworkAccess::Hosts(BTreeSet::new()));
    let result = completed.recv_timeout(Duration::from_secs(2)).unwrap();
    release.send(()).unwrap();
    assert!(matches!(result, Err(ClientError::InvalidRequest(_))));
    caller.join().unwrap();
    server.assert_no_more_requests();
}

#[test]
fn already_cancelled_operations_never_open_a_connection() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let request = ClientRequest::post(
        format!("https://{}/write", listener.local_addr().unwrap()),
        Vec::new(),
        b"payload".to_vec(),
        RetryPolicy::never(),
    )
    .unwrap();
    let source = CancellationSource::new();
    source.cancel();
    assert!(matches!(
        client().execute_with_cancellation(&request, &source.token()),
        Err(ClientError::Cancelled(_))
    ));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn never_policy_does_not_replay_failed_https_writes() {
    for status in [429, 503] {
        let server = Server::reply(response(status, "busy"));
        let request = write_request(&server);
        let result = client()
            .execute_with_cancellation(&request, &CancellationSource::new().token())
            .unwrap();
        assert_eq!(result.status(), status);
        assert_eq!(server.request().body, b"payload");
        server.assert_no_more_requests();
    }
}
