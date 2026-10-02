use super::*;
use crate::HttpClientConfig;
use crate::ProxyPolicy;
use crate::TransportTimeouts;
use std::net::TcpListener;
use std::time::Duration;

struct FailingResolver;
impl Resolve for FailingResolver {
    fn resolve(&self, _: Name) -> Resolving {
        Box::pin(async { Err(Box::new(DnsFailure) as Box<dyn std::error::Error + Send + Sync>) })
    }
}

#[test]
fn diagnostics_retains_the_dns_failure_through_the_reqwest_error_chain() {
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let http = ReqwestHttpClient::sdk_client_builder()
        .unwrap()
        .no_proxy()
        .dns_resolver(Arc::new(FailingResolver))
        .build()
        .unwrap();
    client.inner.http_direct.set(Ok(http)).unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        "http://secret.example.test/?token=private",
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    let error = client.execute(&request).unwrap_err();
    assert_eq!(
        error,
        HttpClientError::Connection(HttpConnectionFailure::Dns)
    );
    assert!(!error.to_string().contains("secret"));
    assert!(!error.to_string().contains("private"));
}

#[test]
fn diagnostics_distinguishes_a_tls_handshake_failure_from_tcp_connect_failure() {
    use std::io::Read;
    use std::io::Write;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://{}/", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 2048];
        assert!(socket.read(&mut bytes).unwrap() > 0);
        // The peer speaks plaintext on an HTTPS port. TCP succeeds; TLS must fail.
        socket
            .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            .unwrap();
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new().with_proxy_policy(ProxyPolicy::Direct),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(HttpMethod::Get, endpoint, Vec::new(), Vec::new()).unwrap();
    assert_eq!(
        client.execute(&request).unwrap_err(),
        HttpClientError::Connection(HttpConnectionFailure::Tls)
    );
    worker.join().unwrap();
}

#[test]
fn diagnostics_reports_the_overall_deadline_as_a_timeout() {
    use std::io::Read;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let (release, released) = std::sync::mpsc::channel::<()>();
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 2048];
        assert!(socket.read(&mut bytes).unwrap() > 0);
        released.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_timeouts(TransportTimeouts::new(
                Timeout::After(Duration::from_secs(2)),
                Timeout::Disabled,
                Timeout::Disabled,
                Timeout::After(Duration::from_millis(200)),
            )),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network).unwrap();
    let request = HttpRequest::new(HttpMethod::Get, endpoint, Vec::new(), Vec::new()).unwrap();
    let result = client.execute(&request);
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(
        result.unwrap_err(),
        HttpClientError::Connection(HttpConnectionFailure::Timeout)
    );
}
