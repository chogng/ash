//! Public backend operations through AshClient, UreqHttpClient, and a loopback TLS server.

use crate::BackendClient;
use crate::CreditNudge;
use crate::RequestError;
use crate::ResetCreditSelection;
use crate::RouteStyle;
use crate::TaskListQuery;
use crate::test_support::target;
use ::client::AshClient;
use async_utils::CancellationSource;
use http_client::CertificateBundle;
use http_client::HttpClientConfig;
use http_client::ProxyPolicy;
use http_client::Timeout;
use http_client::TlsPolicy;
use http_client::TransportTimeouts;
use http_client::UreqHttpClient;
use rustls::ServerConfig;
use rustls::ServerConnection;
use rustls::StreamOwned;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde_json::json;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);
type Connection = StreamOwned<ServerConnection, TcpStream>;

#[derive(Debug)]
struct Request {
    line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> &str {
        let values: Vec<_> = self
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect();
        assert_eq!(values.len(), 1, "expected one {name} header: {self:?}");
        values[0]
    }
}

struct Server {
    address: SocketAddr,
    requests: mpsc::Receiver<Request>,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn reply(bytes: Vec<u8>) -> Self {
        Self::start(move |stream| stream.write_all(&bytes).unwrap())
    }

    fn start(mut respond: impl FnMut(&mut Connection) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let (stop, stopped) = mpsc::channel();
        let (send, requests) = mpsc::channel();
        let config = Arc::new(
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(
                        include_bytes!("../tests/fixtures/server.der").to_vec(),
                    )],
                    PrivatePkcs8KeyDer::from(
                        include_bytes!("../tests/fixtures/server-key.der").to_vec(),
                    )
                    .into(),
                )
                .unwrap(),
        );
        let worker = thread::spawn(move || {
            loop {
                match stopped.try_recv() {
                    Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                match listener.accept() {
                    Ok((socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        socket.set_read_timeout(Some(WAIT)).unwrap();
                        socket.set_write_timeout(Some(WAIT)).unwrap();
                        let mut stream = StreamOwned::new(
                            ServerConnection::new(config.clone()).unwrap(),
                            socket,
                        );
                        let request = read_request(&mut stream);
                        send.send(request).unwrap();
                        respond(&mut stream);
                        stream.flush().unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        match stopped.recv_timeout(Duration::from_millis(10)) {
                            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                        }
                    }
                    Err(error) => panic!("accept test connection: {error}"),
                }
            }
        });
        Self {
            address,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn url(&self) -> String {
        format!("https://{}/backend-api/", self.address)
    }

    fn request(&self) -> Request {
        self.requests
            .recv_timeout(WAIT)
            .expect("backend sent a request")
    }

    fn assert_no_more_requests(&self) {
        assert!(matches!(
            self.requests.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.expect("TLS test server completed");
        }
    }
}

fn read_request(stream: &mut Connection) -> Request {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 16 * 1024, "oversized test request headers");
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    let head = String::from_utf8(bytes).unwrap();
    let mut lines = head.split("\r\n");
    let line = lines.next().unwrap().to_owned();
    let headers: Vec<_> = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_owned(), value.trim().to_owned())
        })
        .collect();
    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.parse::<usize>().unwrap())
        .unwrap_or(0);
    assert!(length < 64 * 1024, "oversized test request body");
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    Request {
        line,
        headers,
        body,
    }
}

fn response(status: u16, body: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

fn client(timeout: Duration) -> AshClient {
    let ca = CertificateBundle::from_der(vec![include_bytes!("../tests/fixtures/ca.der").to_vec()])
        .unwrap();
    let config = HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(TlsPolicy::CustomOnly(ca))
        .with_timeouts(TransportTimeouts::new(
            Timeout::After(WAIT),
            Timeout::After(WAIT),
            Timeout::After(WAIT),
            Timeout::After(timeout),
        ));
    AshClient::new(Arc::new(UreqHttpClient::with_config(config).unwrap()))
}

#[test]
fn both_routes_send_authentication_queries_and_json_over_https() {
    for (route, prefix) in [
        (RouteStyle::Codex, "api/codex"),
        (RouteStyle::ChatGpt, "wham"),
    ] {
        let mut replies = [
            response(200, r#"{"plan_type":"plus"}"#),
            response(200, r#"{"items":[],"cursor":"next"}"#),
            response(201, r#"{"task":{"id":"new-task"}}"#),
            response(204, ""),
        ]
        .into_iter();
        let server = Server::start(move |stream| {
            stream
                .write_all(&replies.next().expect("unexpected extra request"))
                .unwrap()
        });
        let transport = client(WAIT);
        let target = target(&server.url());
        let backend = BackendClient::new(&transport, &target, route).unwrap();
        let token = CancellationSource::new().token();
        assert_eq!(backend.read_rate_limits(&token).unwrap().plan, "plus");
        let list = backend
            .list_tasks(
                &TaskListQuery {
                    limit: Some(10),
                    cursor: Some("next=page"),
                    environment_id: Some("env&one"),
                    task_filter: Some("mine / shared"),
                },
                &token,
            )
            .unwrap();
        assert_eq!(list.cursor.as_deref(), Some("next"));
        let payload = json!({"environment_id":"env","input_items":[{"type":"message","content":["检查 Rust"]}]});
        assert_eq!(
            backend
                .create_task(payload.as_object().unwrap(), &token)
                .unwrap(),
            "new-task"
        );
        backend
            .send_credit_nudge(CreditNudge::Credits, &token)
            .unwrap();
        for (index, request) in (0..4).map(|i| (i, server.request())) {
            for header in &target.headers {
                assert_eq!(request.header(header.name()), header.value());
            }
            match index {
                0 => {
                    assert_eq!(
                        request.line,
                        format!("GET /backend-api/{prefix}/usage HTTP/1.1")
                    );
                    assert!(request.body.is_empty());
                }
                1 => {
                    assert_eq!(
                        request.line,
                        format!(
                            "GET /backend-api/{prefix}/tasks/list?limit=10&task_filter=mine+%2F+shared&cursor=next%3Dpage&environment_id=env%26one HTTP/1.1"
                        )
                    );
                    assert!(request.body.is_empty());
                }
                2 => {
                    assert_eq!(
                        request.line,
                        format!("POST /backend-api/{prefix}/tasks HTTP/1.1")
                    );
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                        payload
                    );
                }
                3 => {
                    assert_eq!(
                        request.line,
                        format!(
                            "POST /backend-api/{prefix}/accounts/send_add_credits_nudge_email HTTP/1.1"
                        )
                    );
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                        json!({"credit_type":"credits"})
                    );
                }
                _ => unreachable!(),
            }
            if index >= 2 {
                assert_eq!(request.header("Content-Type"), "application/json");
            }
        }
        server.assert_no_more_requests();
    }
}

#[test]
fn redirects_do_not_forward_credentials_to_another_origin() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let server = Server::reply(format!("HTTP/1.1 302 Found\r\nLocation: https://{}/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.local_addr().unwrap()).into_bytes());
    let transport = client(Duration::from_secs(1));
    let target = target(&server.url());
    let result = BackendClient::new(&transport, &target, RouteStyle::ChatGpt)
        .unwrap()
        .read_rate_limits(&CancellationSource::new().token());
    assert_eq!(result, Err(RequestError::HttpStatus(302)));
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(server.request().header("Authorization"), "Bearer secret");
    server.assert_no_more_requests();
}

#[test]
fn failed_credit_redemptions_are_never_replayed_by_the_transport() {
    for status in [429, 503] {
        let server = Server::reply(response(status, "private-account-response"));
        let transport = client(WAIT);
        let target = target(&server.url());
        let error = BackendClient::new(&transport, &target, RouteStyle::ChatGpt)
            .unwrap()
            .consume_reset_credit(
                "stable-id",
                ResetCreditSelection::Id("credit-1"),
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, RequestError::HttpStatus(status));
        assert!(!format!("{error:?} {error}").contains("private-account"));
        let request = server.request();
        assert_eq!(
            request.line,
            "POST /backend-api/wham/rate-limit-reset-credits/consume HTTP/1.1"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
            json!({"redeem_request_id":"stable-id","credit_id":"credit-1"})
        );
        server.assert_no_more_requests();
    }
}

#[test]
fn malformed_and_truncated_success_bodies_are_redacted_without_replay() {
    for (wire, expected) in [
        (
            response(200, "<html>private-account</html>"),
            RequestError::InvalidResponse,
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nprivate-account"
                .to_vec(),
            RequestError::Transport,
        ),
    ] {
        let server = Server::reply(wire);
        let transport = client(WAIT);
        let target = target(&server.url());
        let error = BackendClient::new(&transport, &target, RouteStyle::ChatGpt)
            .unwrap()
            .consume_reset_credit(
                "stable-id",
                ResetCreditSelection::Available,
                &CancellationSource::new().token(),
            )
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains("private-account"));
        server.request();
        server.assert_no_more_requests();
    }
}

#[test]
fn cancellation_stops_waiting_for_a_dispatched_write_before_the_server_finishes() {
    let (release, released) = mpsc::channel();
    let server = Server::start(move |_stream| {
        let _ = released.recv_timeout(WAIT);
    });
    let transport = client(WAIT);
    let target = target(&server.url());
    let backend = BackendClient::new(&transport, &target, RouteStyle::ChatGpt).unwrap();
    let source = CancellationSource::new();
    thread::scope(|scope| {
        let (done, completed) = mpsc::channel();
        let token = source.token();
        scope.spawn(move || {
            done.send(backend.consume_reset_credit(
                "stable-id",
                ResetCreditSelection::Available,
                &token,
            ))
            .unwrap();
        });
        server.request();
        source.cancel();
        let result = completed.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        assert_eq!(result.unwrap(), Err(RequestError::Cancelled));
    });
    server.assert_no_more_requests();
}

#[test]
fn request_deadline_is_reported_without_retrying_the_write() {
    let (release, released) = mpsc::channel();
    let server = Server::start(move |stream| {
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"code\":",
            )
            .unwrap();
        stream.flush().unwrap();
        let _ = released.recv_timeout(WAIT);
    });
    let transport = client(Duration::from_millis(250));
    let target = target(&server.url());
    thread::scope(|scope| {
        let (done, completed) = mpsc::channel();
        scope.spawn(move || {
            done.send(
                BackendClient::new(&transport, &target, RouteStyle::ChatGpt)
                    .unwrap()
                    .consume_reset_credit(
                        "stable-id",
                        ResetCreditSelection::Available,
                        &CancellationSource::new().token(),
                    ),
            )
            .unwrap();
        });
        server.request();
        let result = completed.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        assert_eq!(result.unwrap(), Err(RequestError::Transport));
    });
    server.assert_no_more_requests();
}

#[test]
fn already_cancelled_operations_never_open_a_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let target = target(&format!("https://{}", listener.local_addr().unwrap()));
    let transport = client(WAIT);
    let source = CancellationSource::new();
    source.cancel();
    assert_eq!(
        BackendClient::new(&transport, &target, RouteStyle::Codex)
            .unwrap()
            .consume_reset_credit(
                "stable-id",
                ResetCreditSelection::Available,
                &source.token()
            ),
        Err(RequestError::Cancelled)
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
