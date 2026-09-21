use crate::CertificateBundle;
use crate::HttpClient;
use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::HttpHeader;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::ProxyPolicy;
use crate::Timeout;
use crate::TlsPolicy;
use crate::TransportTimeouts;
use crate::UreqHttpClient;
use http_test_support::CA_DER;
use http_test_support::Server;
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

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
