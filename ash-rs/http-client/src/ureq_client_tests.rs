use crate::CertificateBundle;
use crate::HttpClient;
use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::HttpHeader;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::ProxyBypass;
use crate::ProxyPolicy;
use crate::RedirectPolicy;
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
    let client = UreqHttpClient::with_config(
        HttpClientConfig::new()
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
                Timeout::After(WAIT),
                Timeout::After(WAIT),
            )),
    )
    .unwrap();
    let request = HttpRequest::new(
        HttpMethod::Get,
        format!("{}/start", source.url()),
        vec![HttpHeader::new("Authorization", "Bearer secret")],
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
    assert!(matches!(error, HttpClientError::Transport(_)));
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
