use crate::CertificateBundle;
use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::HttpHeader;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::ProxyBypass;
use crate::ProxyPolicy;
use crate::RedirectPolicy;
use crate::ReqwestHttpClient;
use crate::Timeout;
use crate::TlsPolicy;
use crate::TransportTimeouts;
use crate::UreqHttpClient;
use http_test_support::CA_DER;
use http_test_support::Server;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::num::NonZeroU8;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const WAIT: Duration = Duration::from_secs(5);

fn client(timeout: Duration) -> UreqHttpClient {
    let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    UreqHttpClient::with_config(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_tls_policy(TlsPolicy::CustomOnly(ca))
            .with_timeouts(TransportTimeouts::new(
                Timeout::After(WAIT),
                Timeout::After(WAIT),
                Timeout::After(WAIT),
                Timeout::After(timeout),
            )),
    )
    .unwrap()
}

#[test]
fn redirects_do_not_forward_credentials_to_another_origin() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let server = Server::reply(format!("HTTP/1.1 302 Found\r\nLocation: https://{}/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.local_addr().unwrap()).into_bytes());
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("{}/resource", server.url()),
        vec![HttpHeader::new("Authorization", "Bearer secret")],
        Vec::new(),
    )
    .unwrap();
    let result = client(Duration::from_secs(1)).execute(&request).unwrap();
    assert_eq!(result.status(), 302);
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(server.request().header("Authorization"), "Bearer secret");
    server.assert_no_more_requests();
}

#[test]
fn redirect_selects_the_destination_proxy_route_without_forwarding_credentials() {
    for reqwest in [false, true] {
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = proxy.local_addr().unwrap();
        proxy.set_nonblocking(true).unwrap();
        let proxy_worker = thread::spawn(move || {
            let started = Instant::now();
            loop {
                match proxy.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(WAIT)).unwrap();
                        let mut headers = Vec::new();
                        while !headers.ends_with(b"\r\n\r\n") {
                            let mut byte = [0];
                            stream.read_exact(&mut byte).unwrap();
                            headers.push(byte[0]);
                        }
                        stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .unwrap();
                        return String::from_utf8(headers).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(started.elapsed() < WAIT, "redirect never reached the proxy");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("proxy accept failed: {error}"),
                }
            }
        });
        let source = Server::reply(b"HTTP/1.1 302 Found\r\nLocation: http://destination.invalid/asset\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
        let config = HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::ExplicitWithBypass {
                proxy_url: format!("http://{proxy_address}"),
                bypass: ProxyBypass::from_comma_separated("127.0.0.1"),
            })
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: NonZeroU8::new(3).unwrap(),
            })
            .with_tls_policy(TlsPolicy::CustomOnly(ca))
            .with_timeouts(TransportTimeouts::new(
                Timeout::After(WAIT),
                Timeout::After(WAIT),
                Timeout::Disabled,
                Timeout::After(WAIT),
            ));
        let client: Box<dyn HttpClient> = if reqwest {
            Box::new(
                ReqwestHttpClient::with_network(
                    crate::OutboundNetworkSnapshot::new(config).unwrap(),
                )
                .unwrap(),
            )
        } else {
            Box::new(UreqHttpClient::with_config(config).unwrap())
        };
        let request = HttpRequest::new(
            HttpMethod::Get,
            format!("{}/start", source.url()),
            vec![
                HttpHeader::new("Authorization", "Bearer secret"),
                HttpHeader::new("Proxy-Authorization", "Basic proxy-secret"),
            ],
            Vec::new(),
        )
        .unwrap();
        let result = client.execute(&request);
        let proxy_request = proxy_worker.join().unwrap();
        assert_eq!(result.unwrap().body(), b"ok");
        assert!(proxy_request.starts_with("GET http://destination.invalid/asset HTTP/1.1\r\n"));
        assert!(
            !proxy_request
                .to_ascii_lowercase()
                .contains("authorization:")
        );
        assert_eq!(source.request().header("Authorization"), "Bearer secret");
        source.assert_no_more_requests();
    }
}

#[test]
fn relative_redirect_changes_post_to_get_without_replaying_its_body() {
    let mut responses = 0;
    let server = Server::start(move |stream| {
        responses += 1;
        if responses == 1 {
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        } else {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        }
    });
    let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let client = UreqHttpClient::with_config(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: NonZeroU8::new(3).unwrap(),
            })
            .with_tls_policy(TlsPolicy::CustomOnly(ca)),
    )
    .unwrap();
    let request = HttpRequest::post(
        format!("{}/start", server.url()),
        vec![HttpHeader::new("Content-Type", "application/octet-stream")],
        b"payload".to_vec(),
    )
    .unwrap();
    assert_eq!(client.execute(&request).unwrap().body(), b"ok");
    let first = server.request();
    let second = server.request();
    assert_eq!(first.line, "POST /start HTTP/1.1");
    assert_eq!(first.body, b"payload");
    assert_eq!(second.line, "GET /next HTTP/1.1");
    assert!(second.body.is_empty());
    server.assert_no_more_requests();
}

#[test]
fn redirect_limit_stops_repeated_requests_without_exposing_the_location() {
    let server = Server::reply(b"HTTP/1.1 302 Found\r\nLocation: /private?token=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let client = UreqHttpClient::with_config(
        HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::Direct)
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: NonZeroU8::new(1).unwrap(),
            })
            .with_tls_policy(TlsPolicy::CustomOnly(ca)),
    )
    .unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("{}/start", server.url()),
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    let error = client.execute(&request).unwrap_err();
    assert_eq!(error, HttpClientError::RedirectLimitExceeded);
    assert!(!format!("{error:?} {error}").contains("secret"));
    assert_eq!(server.request().line, "GET /start HTTP/1.1");
    assert_eq!(server.request().line, "GET /private?token=secret HTTP/1.1");
    server.assert_no_more_requests();
}

#[test]
fn request_deadline_ends_a_stalled_body_without_retrying() {
    let (release, released) = mpsc::channel();
    let server = Server::start(move |stream| {
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial",
            )
            .unwrap();
        stream.flush().unwrap();
        let _ = released.recv_timeout(WAIT);
    });
    let request = HttpRequest::post(
        format!("{}/write", server.url()),
        Vec::new(),
        b"payload".to_vec(),
    )
    .unwrap();
    let transport = client(Duration::from_millis(250));
    thread::scope(|scope| {
        let (done, completed) = mpsc::channel();
        scope.spawn(move || {
            done.send(transport.execute(&request)).unwrap();
        });
        assert_eq!(server.request().body, b"payload");
        let result = completed.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        assert!(matches!(
            result.unwrap(),
            Err(HttpClientError::Transport(_))
        ));
    });
    server.assert_no_more_requests();
}

#[test]
fn truncated_https_body_is_a_transport_error_without_replay_or_body_disclosure() {
    let server = Server::reply(
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nprivate-body".to_vec(),
    );
    let request = HttpRequest::post(
        format!("{}/write", server.url()),
        Vec::new(),
        b"payload".to_vec(),
    )
    .unwrap();
    let error = client(WAIT).execute(&request).unwrap_err();
    assert!(matches!(error, HttpClientError::Transport(_)));
    assert!(!format!("{error:?} {error}").contains("private-body"));
    assert_eq!(server.request().body, b"payload");
    server.assert_no_more_requests();
}

#[test]
fn credential_bound_custom_headers_reject_redirects_even_when_network_follows() {
    let ca = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(ca))
        .with_redirect_policy(RedirectPolicy::Follow {
            max_hops: NonZeroU8::new(3).unwrap(),
        });
    let transports: [(&str, Box<dyn HttpClient>); 2] = [
        (
            "ureq",
            Box::new(UreqHttpClient::with_config(config.clone()).unwrap()),
        ),
        (
            "reqwest",
            Box::new(
                ReqwestHttpClient::with_network(
                    crate::OutboundNetworkSnapshot::new(config).unwrap(),
                )
                .unwrap(),
            ),
        ),
    ];
    for (name, transport) in transports {
        for status in [301, 302, 303, 307, 308] {
            for streaming in [false, true] {
                let destination = Server::reply(http_test_support::response(200, "destination"));
                let server = Server::reply(format!("HTTP/1.1 {status} Redirect\r\nLocation: {}/private\r\nContent-Length: 8\r\nConnection: close\r\n\r\nredirect", destination.url()).into_bytes());
                let request = HttpRequest::new(
                    HttpMethod::Get,
                    format!("{}/resource", server.url()),
                    vec![
                        HttpHeader::new("X-Device-Proof", "secret-proof"),
                        HttpHeader::new("x-api-key", "secret-key"),
                    ],
                    vec![],
                )
                .unwrap()
                .without_redirects();
                let response = if streaming {
                    transport.execute_streaming(&request, &mut RejectBodySink)
                } else {
                    transport.execute(&request)
                }
                .unwrap();
                assert_eq!(
                    (response.status(), response.body()),
                    (status, b"redirect".as_slice()),
                    "{name}, streaming={streaming}",
                );
                let captured = server.request();
                assert_eq!(captured.header("X-Device-Proof"), "secret-proof");
                assert_eq!(captured.header("x-api-key"), "secret-key");
                server.assert_no_more_requests();
                destination.assert_no_more_requests();

                let allowed = HttpRequest::new(
                    HttpMethod::Get,
                    format!("{}/resource", server.url()),
                    vec![],
                    vec![],
                )
                .unwrap();
                assert_eq!(transport.execute(&allowed).unwrap().body(), b"destination");
                assert_eq!(server.request().line, "GET /resource HTTP/1.1");
                assert_eq!(destination.request().line, "GET /private HTTP/1.1");
                server.assert_no_more_requests();
                destination.assert_no_more_requests();
            }
        }
    }
}

struct RejectBodySink;

impl HttpBodySink for RejectBodySink {
    fn emit(&mut self, _: &[u8]) -> Result<(), HttpClientError> {
        panic!("redirect response bodies must remain buffered");
    }
}

#[test]
fn redirected_get_drops_proxy_credentials_and_discarded_body_headers() {
    let roots = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(roots))
        .with_redirect_policy(RedirectPolicy::Follow {
            max_hops: NonZeroU8::new(3).unwrap(),
        });
    let transports: [Box<dyn HttpClient>; 2] = [
        Box::new(UreqHttpClient::with_config(config.clone()).unwrap()),
        Box::new(
            ReqwestHttpClient::with_network(crate::OutboundNetworkSnapshot::new(config).unwrap())
                .unwrap(),
        ),
    ];
    for transport in transports {
        for status in [301, 302, 303] {
            for streaming in [false, true] {
                let destination = Server::reply(http_test_support::response(200, "ok"));
                let server = Server::reply(format!("HTTP/1.1 {status} Redirect\r\nLocation: {}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.url()).into_bytes());
                let request = HttpRequest::post(
                    format!("{}/start", server.url()),
                    vec![
                        HttpHeader::new("Proxy-Authorization", "Basic proxy-secret"),
                        HttpHeader::new("Content-Type", "application/octet-stream"),
                        HttpHeader::new("Content-Encoding", "gzip"),
                        HttpHeader::new("X-Request-Id", "request-id"),
                    ],
                    b"payload".to_vec(),
                )
                .unwrap();
                if streaming {
                    let mut sink = CollectedBody::default();
                    let response = transport.execute_streaming(&request, &mut sink).unwrap();
                    assert_eq!(response.status(), 200);
                    assert!(response.body().is_empty());
                    assert_eq!(sink.0, b"ok");
                } else {
                    assert_eq!(transport.execute(&request).unwrap().body(), b"ok");
                }
                let initial = server.request();
                assert_eq!(initial.line, "POST /start HTTP/1.1");
                assert_eq!(initial.body, b"payload");
                assert_eq!(initial.header("Proxy-Authorization"), "Basic proxy-secret");
                let redirected = destination.request();
                assert_eq!(redirected.line, "GET /next HTTP/1.1");
                assert!(redirected.body.is_empty());
                for name in [
                    "Proxy-Authorization",
                    "Content-Type",
                    "Content-Encoding",
                    "Transfer-Encoding",
                ] {
                    assert!(!redirected.has_header(name), "redirect forwarded {name}");
                }
                assert_eq!(redirected.header("X-Request-Id"), "request-id");
                server.assert_no_more_requests();
                destination.assert_no_more_requests();
            }
        }
    }
}

#[derive(Default)]
struct CollectedBody(Vec<u8>);

impl HttpBodySink for CollectedBody {
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        self.0.extend_from_slice(chunk);
        Ok(())
    }
}

#[test]
fn response_limits_return_typed_failures_in_both_transports() {
    let roots = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(roots))
        .with_response_body_limit(
            crate::ResponseBodyLimit::new(std::num::NonZeroUsize::new(3).unwrap()).unwrap(),
        )
        .with_streaming_response_body_limit(
            crate::ResponseBodyLimit::new(std::num::NonZeroUsize::new(5).unwrap()).unwrap(),
        );
    let transports: [(&str, Box<dyn HttpClient>); 2] = [
        (
            "ureq",
            Box::new(UreqHttpClient::with_config(config.clone()).unwrap()),
        ),
        (
            "reqwest",
            Box::new(
                ReqwestHttpClient::with_network(
                    crate::OutboundNetworkSnapshot::new(config).unwrap(),
                )
                .unwrap(),
            ),
        ),
    ];
    for (name, transport) in transports {
        for streaming in [false, true] {
            for status in [200, 503] {
                let limit = if streaming && status == 200 { 5 } else { 3 };
                for length in [limit, limit + 1] {
                    let body = "x".repeat(length);
                    let server = Server::reply(http_test_support::response(status, &body));
                    let request = HttpRequest::new(
                        HttpMethod::Get,
                        format!("{}/body", server.url()),
                        vec![],
                        vec![],
                    )
                    .unwrap();
                    let mut sink = CollectedBody::default();
                    let result = if streaming {
                        transport.execute_streaming(&request, &mut sink)
                    } else {
                        transport.execute(&request)
                    };
                    if length > limit {
                        assert_eq!(
                            result,
                            Err(HttpClientError::ResponseTooLarge),
                            "{name}, streaming={streaming}, status={status}"
                        );
                        assert!(sink.0.len() <= limit);
                    } else {
                        let response = result.unwrap();
                        assert_eq!(response.status(), status);
                        if streaming && status == 200 {
                            assert_eq!(sink.0, body.as_bytes());
                            assert!(response.body().is_empty());
                        } else {
                            assert_eq!(response.body(), body.as_bytes());
                            assert!(sink.0.is_empty());
                        }
                    }
                    assert_eq!(server.request().line, "GET /body HTTP/1.1");
                    server.assert_no_more_requests();
                }
            }
        }
    }
}

#[test]
fn proxy_redirect_to_a_bypassed_target_does_not_forward_credentials() {
    for reqwest in [false, true] {
        let destination = Server::reply(http_test_support::response(200, "ok"));
        let redirect = format!(
            "HTTP/1.1 302 Found\r\nLocation: {}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            destination.url()
        );
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_address = proxy.local_addr().unwrap();
        proxy.set_nonblocking(true).unwrap();
        let worker = thread::spawn(move || {
            let started = Instant::now();
            loop {
                match proxy.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(WAIT)).unwrap();
                        stream.set_write_timeout(Some(WAIT)).unwrap();
                        let mut headers = Vec::new();
                        while !headers.ends_with(b"\r\n\r\n") {
                            assert!(headers.len() < 16 * 1024);
                            let mut byte = [0];
                            stream.read_exact(&mut byte).unwrap();
                            headers.push(byte[0]);
                        }
                        stream.write_all(redirect.as_bytes()).unwrap();
                        return String::from_utf8(headers).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(started.elapsed() < WAIT, "request never reached the proxy");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("proxy accept failed: {error}"),
                }
            }
        });
        let roots = CertificateBundle::from_der(vec![CA_DER.to_vec()]).unwrap();
        let config = HttpClientConfig::new()
            .with_proxy_policy(ProxyPolicy::ExplicitWithBypass {
                proxy_url: format!("http://{proxy_address}"),
                bypass: ProxyBypass::from_comma_separated("127.0.0.1"),
            })
            .with_tls_policy(TlsPolicy::CustomOnly(roots))
            .with_redirect_policy(RedirectPolicy::Follow {
                max_hops: NonZeroU8::new(3).unwrap(),
            })
            .with_timeouts(TransportTimeouts::new(
                Timeout::After(WAIT),
                Timeout::After(WAIT),
                Timeout::Disabled,
                Timeout::After(WAIT),
            ));
        let client: Box<dyn HttpClient> = if reqwest {
            Box::new(
                ReqwestHttpClient::with_network(
                    crate::OutboundNetworkSnapshot::new(config).unwrap(),
                )
                .unwrap(),
            )
        } else {
            Box::new(UreqHttpClient::with_config(config).unwrap())
        };
        let request = HttpRequest::new(
            HttpMethod::Get,
            "http://source.invalid/start",
            vec![
                HttpHeader::new("Authorization", "Bearer origin-secret"),
                HttpHeader::new("Cookie", "session=secret"),
                HttpHeader::new("Proxy-Authorization", "Basic proxy-secret"),
            ],
            vec![],
        )
        .unwrap();
        let result = client.execute(&request);
        let initial = worker.join().unwrap();
        assert_eq!(result.unwrap().body(), b"ok");
        assert!(initial.starts_with("GET http://source.invalid/start HTTP/1.1\r\n"));
        assert!(
            initial
                .to_ascii_lowercase()
                .contains("proxy-authorization: basic proxy-secret\r\n")
        );
        let redirected = destination.request();
        assert_eq!(redirected.line, "GET /next HTTP/1.1");
        for header in ["Authorization", "Cookie", "Proxy-Authorization"] {
            assert!(
                !redirected.has_header(header),
                "redirect forwarded {header}"
            );
        }
        destination.assert_no_more_requests();
    }
}
