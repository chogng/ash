//! Loopback HTTPS fixtures for Rust tests. No product client or protocol dependencies.

use rustls::ServerConfig;
use rustls::ServerConnection;
use rustls::StreamOwned;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::PrivatePkcs8KeyDer;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Trust anchor for the loopback test server; never added to system trust.
pub const CA_DER: &[u8] = include_bytes!("../fixtures/ca.der");
const WAIT: Duration = Duration::from_secs(5);

/// An observed request; header lookup asserts that exactly one matching header exists.
#[derive(Debug)]
pub struct Request {
    pub line: String,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> &str {
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

/// A loopback HTTPS server whose worker is stopped and joined when dropped.
pub struct Server {
    address: SocketAddr,
    requests: mpsc::Receiver<Request>,
    stop: mpsc::Sender<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    /// Sends the same raw response for each request, so tests can detect unexpected replays.
    pub fn reply(bytes: Vec<u8>) -> Self {
        Self::start(move |stream| stream.write_all(&bytes).unwrap())
    }

    /// Records each request before calling the response writer. The callback may use
    /// channels to hold a response open while the client is cancelled or times out.
    pub fn start(mut respond: impl FnMut(&mut dyn Write) + Send + 'static) -> Self {
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
                        include_bytes!("../fixtures/server.der").to_vec(),
                    )],
                    PrivatePkcs8KeyDer::from(include_bytes!("../fixtures/server-key.der").to_vec())
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

    pub fn url(&self) -> String {
        format!("https://{}", self.address)
    }

    pub fn request(&self) -> Request {
        self.requests
            .recv_timeout(WAIT)
            .expect("test client sent a request")
    }

    /// Checks recorded requests after the caller has observed operation completion.
    pub fn assert_no_more_requests(&self) {
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

fn read_request(stream: &mut impl Read) -> Request {
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

/// Builds an HTTP response with an exact byte length and a closing connection.
pub fn response(status: u16, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}
