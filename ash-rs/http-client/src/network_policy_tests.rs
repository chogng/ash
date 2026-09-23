use crate::HttpBodySink;
use crate::HttpClient;
use crate::HttpClientConfig;
use crate::HttpClientError;
use crate::HttpMethod;
use crate::HttpRequest;
use crate::HttpResponse;
use crate::NetworkAccess;
use crate::OutboundNetworkPolicy;
use crate::OutboundNetworkSnapshot;
use crate::PolicyHttpClient;
use crate::ProxyPolicy;
use crate::RedirectPolicy;
use crate::UreqHttpClient;
use std::collections::BTreeSet;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::Mutex;
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

struct BlockingClient {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl HttpClient for BlockingClient {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.entered.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        Ok(HttpResponse::new(200, Vec::new(), Vec::new()))
    }
}

#[test]
fn active_http_call_ends_when_policy_revokes_its_host() {
    let policy = OutboundNetworkPolicy::new(hosts(&["api.example.com"]));
    let (entered, started) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let inner = Arc::new(BlockingClient {
        entered,
        release: Mutex::new(released),
    });
    let client = PolicyHttpClient::new(inner, policy.clone());
    let request = HttpRequest::new(
        HttpMethod::Get,
        "https://api.example.com/v1",
        Vec::new(),
        Vec::new(),
    )
    .unwrap();
    let (finished, result) = mpsc::channel();
    let caller = std::thread::spawn(move || finished.send(client.execute(&request)).unwrap());
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    policy.update(hosts(&[]));
    let error = result
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap_err();
    assert!(matches!(error, HttpClientError::InvalidRequest(_)));
    release.send(()).unwrap();
    caller.join().unwrap();
}

struct BlockingStream {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl HttpClient for BlockingStream {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        unreachable!()
    }

    fn execute_streaming(
        &self,
        _: &HttpRequest,
        sink: &mut dyn HttpBodySink,
    ) -> Result<HttpResponse, HttpClientError> {
        sink.emit(b"first")?;
        self.entered.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        Ok(HttpResponse::new(200, Vec::new(), Vec::new()))
    }
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

#[test]
fn active_http_stream_stops_delivering_after_policy_revocation() {
    let policy = OutboundNetworkPolicy::new(hosts(&["api.example.com"]));
    let (entered, started) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let client = PolicyHttpClient::new(
        Arc::new(BlockingStream {
            entered,
            release: Mutex::new(released),
        }),
        policy.clone(),
    );
    let request = HttpRequest::new(
        HttpMethod::Get,
        "https://api.example.com/v1",
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
    let (outcome, chunks) = result.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(outcome, Err(HttpClientError::InvalidRequest(_))));
    assert_eq!(chunks, b"first");
    release.send(()).unwrap();
    caller.join().unwrap();
}
