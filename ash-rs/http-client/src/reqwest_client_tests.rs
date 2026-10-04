use super::*;
use crate::HttpClientConfig;
use crate::ProxyPolicy;
use crate::TransportTimeouts;
use std::net::TcpListener;
use std::time::Duration;

struct FailingResolver;

#[test]
fn patch_and_put_reach_the_peer_with_their_method_and_body() {
    for (method, expected) in [(HttpMethod::Patch, "PATCH"), (HttpMethod::Put, "PUT")] {
        let server = http_test_support::Server::reply(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
        );
        let config = HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(crate::TlsPolicy::CustomOnly(
                crate::CertificateBundle::from_der(vec![http_test_support::CA_DER.to_vec()])
                    .unwrap(),
            ));
        let clients: Vec<Box<dyn HttpClient>> = vec![
            Box::new(
                ReqwestHttpClient::with_network(
                    OutboundNetworkSnapshot::new(config.clone()).unwrap(),
                )
                .unwrap(),
            ),
            Box::new(crate::UreqHttpClient::with_config(config).unwrap()),
        ];
        let request = HttpRequest::new(
            method,
            format!("{}/resource", server.url()),
            vec![],
            b"{\"title\":\"updated\"}".to_vec(),
        )
        .unwrap();
        for client in clients {
            assert_eq!(client.execute(&request).unwrap().status(), 200);
            let received = server.request();
            assert!(received.line.starts_with(expected));
            assert_eq!(received.body, b"{\"title\":\"updated\"}");
        }
    }
}
impl Resolve for FailingResolver {
    fn resolve(&self, _: Name) -> Resolving {
        Box::pin(async { Err(Box::new(DnsFailure) as Box<dyn std::error::Error + Send + Sync>) })
    }
}

#[test]
fn patch_and_put_do_not_replay_on_redirects() {
    for method in [HttpMethod::Patch, HttpMethod::Put] {
        for status in [301, 302, 307, 308] {
            let server = http_test_support::Server::reply(format!("HTTP/1.1 {status} Redirect\r\nLocation: /another\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes());
            let config = HttpClientConfig::new()
                .with_proxy_policy(ProxyPolicy::Direct)
                .with_redirect_policy(crate::RedirectPolicy::Follow {
                    max_hops: std::num::NonZeroU8::new(2).unwrap(),
                })
                .with_tls_policy(crate::TlsPolicy::CustomOnly(
                    crate::CertificateBundle::from_der(vec![http_test_support::CA_DER.to_vec()])
                        .unwrap(),
                ));
            let clients: Vec<Box<dyn HttpClient>> = vec![
                Box::new(
                    ReqwestHttpClient::with_network(
                        OutboundNetworkSnapshot::new(config.clone()).unwrap(),
                    )
                    .unwrap(),
                ),
                Box::new(crate::UreqHttpClient::with_config(config).unwrap()),
            ];
            let request = HttpRequest::new(
                method,
                format!("{}/resource", server.url()),
                vec![],
                b"change".to_vec(),
            )
            .unwrap();
            for client in clients {
                assert_eq!(client.execute(&request).unwrap().status(), status);
                assert_eq!(server.request().body, b"change");
                server.assert_no_more_requests();
            }
        }
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
    client.inner.pools[0].http_direct.set(Ok(http)).unwrap();
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

#[test]
fn http_compatibility_switch_changes_the_wire_alpn_without_replacing_the_shared_client() {
    use crate::CertificateBundle;
    use crate::HttpCompatibilityMode;
    use crate::TlsPolicy;
    use std::io::Read;
    use std::io::Write;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://{}/", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let mut offers = Vec::new();
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![rustls::pki_types::CertificateDer::from(
                include_bytes!("../../http-test-support/fixtures/server.der").to_vec(),
            )],
            rustls::pki_types::PrivatePkcs8KeyDer::from(
                include_bytes!("../../http-test-support/fixtures/server-key.der").to_vec(),
            )
            .into(),
        )
        .unwrap();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = Arc::new(config);
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut acceptor = rustls::server::Acceptor::default();
            let accepted = loop {
                acceptor.read_tls(&mut socket).unwrap();
                if let Some(accepted) = acceptor.accept().unwrap() {
                    break accepted;
                }
            };
            offers.push(
                accepted
                    .client_hello()
                    .alpn()
                    .unwrap()
                    .map(<[u8]>::to_vec)
                    .collect::<Vec<_>>(),
            );
            let connection = accepted.into_connection(config.clone()).unwrap();
            let mut stream = rustls::StreamOwned::new(connection, socket);
            let mut request = [0; 2048];
            let size = stream.read(&mut request).unwrap();
            assert!(
                std::str::from_utf8(&request[..size])
                    .unwrap()
                    .starts_with("GET / HTTP/1.1")
            );
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            stream.flush().unwrap();
        }
        offers
    });
    let roots = CertificateBundle::from_der(vec![http_test_support::CA_DER.to_vec()]).unwrap();
    let network = OutboundNetworkSnapshot::new(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(TlsPolicy::CustomOnly(roots)),
    )
    .unwrap();
    let client = ReqwestHttpClient::with_network(network.clone()).unwrap();
    let request = HttpRequest::new(HttpMethod::Get, endpoint, Vec::new(), Vec::new()).unwrap();
    for (revision, mode) in [
        HttpCompatibilityMode::Http2,
        HttpCompatibilityMode::Http1,
        HttpCompatibilityMode::Http2,
    ]
    .into_iter()
    .enumerate()
    {
        network.set_http_compatibility_mode(mode, revision as u64);
        assert_eq!(client.execute(&request).unwrap().status(), 401);
    }
    assert_eq!(
        worker.join().unwrap(),
        vec![
            vec![b"h2".to_vec(), b"http/1.1".to_vec()],
            vec![b"http/1.1".to_vec()],
            vec![b"h2".to_vec(), b"http/1.1".to_vec()],
        ]
    );
}

#[test]
fn http_compatibility_ignores_an_older_config_observation() {
    let network = OutboundNetworkSnapshot::new(HttpClientConfig::new()).unwrap();
    network.set_http_compatibility_mode(HttpCompatibilityMode::Http1, 2);
    network.set_http_compatibility_mode(HttpCompatibilityMode::Http2, 1);
    assert_eq!(
        network.http_compatibility_mode(),
        HttpCompatibilityMode::Http1
    );
    network.set_http_compatibility_mode(HttpCompatibilityMode::Http2, 3);
    assert_eq!(
        network.http_compatibility_mode(),
        HttpCompatibilityMode::Http2
    );
}
