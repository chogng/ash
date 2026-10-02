use crate::CertificateBundle;
use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::NetworkAccess;
use crate::NetworkTargetPolicy;
use crate::OutboundNetworkPolicy;
use crate::OutboundNetworkSnapshot;
use crate::ProxyPolicy;
use crate::RedirectPolicy;
use crate::ReqwestHttpClient;
use crate::TlsPolicy;
use crate::UreqHttpClient;
use ash_async_utils::CancellationSource;
use http_test_support::CA_DER;
use http_test_support::Server;
use std::collections::BTreeSet;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

fn hosts(values: &[&str]) -> NetworkAccess {
    NetworkAccess::Hosts(
        values
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<BTreeSet<_>>(),
    )
}

#[test]
fn policy_matches_exact_hosts_and_applies_updates() {
    let policy = OutboundNetworkPolicy::new(hosts(&["api.example.com", "::1"]));
    assert!(policy.check_url("https://api.example.com/v1").is_ok());
    assert!(policy.check_url("wss://[::1]/events").is_ok());
    assert!(policy.check_url("https://other.example.com").is_err());
    assert!(
        policy
            .check_url("https://api.example.com.evil.test")
            .is_err()
    );

    policy.update(hosts(&[]));
    assert!(policy.check_url("https://api.example.com/v1").is_err());
    policy.update(NetworkAccess::Any);
    assert!(policy.check_url("https://other.example.com").is_ok());
}

#[test]
fn revoked_request_cannot_resume_after_policy_is_relaxed() {
    let policy = OutboundNetworkPolicy::new(hosts(&["api.example.com"]));
    let permit = policy.acquire("https://api.example.com/v1").unwrap();
    policy.update(hosts(&[]));
    policy.update(hosts(&["api.example.com"]));
    assert!(permit.check().is_err());
    assert!(policy.acquire("https://api.example.com/v1").is_ok());
}

#[test]
fn cancellable_transport_preserves_custom_tls_trust() {
    let server = Server::reply(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec(),
    );
    let roots = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(TlsPolicy::CustomOnly(roots)),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(HttpMethod::Get, server.url(), Vec::new(), Vec::new()).unwrap();
    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    assert_eq!(server.request().line, "GET / HTTP/1.1");
}

#[test]
fn cancellable_transport_rejects_private_ip_before_connecting() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_network_target_policy(NetworkTargetPolicy::PublicInternetOnly),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{}/image", listener.local_addr().unwrap()),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    assert!(matches!(
        client.execute(&request),
        Err(HttpClientError::Transport(_))
    ));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn cancellable_transport_rechecks_redirect_target() {
    let server = Server::reply(b"HTTP/1.1 302 Found\r\nLocation: https://blocked.example.test/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    let policy = OutboundNetworkPolicy::new(hosts(&["127.0.0.1"]));
    let roots = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let network = OutboundNetworkSnapshot::with_policy(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: std::num::NonZeroU8::new(2).unwrap(),
            })
            .with_tls_policy(TlsPolicy::CustomOnly(roots)),
        policy,
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(HttpMethod::Get, server.url(), Vec::new(), Vec::new()).unwrap();
    assert!(matches!(
        client.execute(&request),
        Err(HttpClientError::InvalidRequest(_))
    ));
    assert_eq!(server.request().line, "GET / HTTP/1.1");
    server.assert_no_more_requests();
}

#[test]
fn cancellable_transport_uses_selected_proxy() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (request_line, seen) = mpsc::channel();
    let proxy = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        let count = stream.read(&mut request).unwrap();
        request_line
            .send(
                String::from_utf8_lossy(&request[..count])
                    .lines()
                    .next()
                    .unwrap()
                    .to_owned(),
            )
            .unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Explicit(format!("http://{address}"))),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        "http://example.test/data",
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    assert_eq!(
        seen.recv_timeout(Duration::from_secs(2)).unwrap(),
        "GET http://example.test/data HTTP/1.1"
    );
    proxy.join().unwrap();
}

#[test]
fn revocation_cancels_the_active_http_body_read() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted, started) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nfirst")
            .unwrap();
        accepted.send(()).unwrap();
        match stream.read(&mut request) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("request socket stayed open after revocation: {other:?}"),
        }
    });
    let policy = OutboundNetworkPolicy::new(hosts(&["127.0.0.1"]));
    let network = OutboundNetworkSnapshot::with_policy(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
        policy.clone(),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{address}/stream"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    let (observed, delivered) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    let caller = std::thread::spawn(move || {
        let mut sink = RecordingSink {
            bytes: Vec::new(),
            observed,
        };
        finished
            .send((client.execute_streaming(&request, &mut sink), sink.bytes))
            .unwrap();
    });
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    delivered.recv_timeout(Duration::from_secs(2)).unwrap();
    policy.update(hosts(&[]));
    policy.update(hosts(&["127.0.0.1"]));
    let (outcome, bytes) = result.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(outcome, Err(HttpClientError::InvalidRequest(_))));
    assert_eq!(bytes, b"first");
    caller.join().unwrap();
    server.join().unwrap();
}

#[test]
fn caller_cancellation_closes_the_active_http_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (accepted, started) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nfirst")
            .unwrap();
        accepted.send(()).unwrap();
        match stream.read(&mut request) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("request socket stayed open after cancellation: {other:?}"),
        }
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{address}/stream"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let (finished, result) = mpsc::channel();
    let caller = std::thread::spawn(move || {
        finished
            .send(client.execute_with_cancellation(&request, &token))
            .unwrap();
    });
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    cancellation.cancel();
    assert!(matches!(
        result.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(HttpClientError::Transport(_))
    ));
    caller.join().unwrap();
    server.join().unwrap();
}

#[test]
fn redirected_http_request_rechecks_the_destination_host() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream
            .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://blocked.example.test/next\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
    });
    let policy = OutboundNetworkPolicy::new(hosts(&["127.0.0.1"]));
    let network = OutboundNetworkSnapshot::with_policy(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: std::num::NonZeroU8::new(1).unwrap(),
            }),
        policy,
    )
    .unwrap();
    let client = UreqHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("http://{address}/start"),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    assert!(matches!(
        client.execute(&request),
        Err(HttpClientError::InvalidRequest(_))
    ));
    server.join().unwrap();
}

struct RecordingSink {
    bytes: Vec<u8>,
    observed: mpsc::Sender<()>,
}

impl HttpBodySink for RecordingSink {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        self.bytes.extend_from_slice(chunk);
        self.observed.send(()).unwrap();
        Ok(())
    }
}
