use std::future::Future;
use std::io;
use std::io::Read;
use std::io::Write;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use futures::SinkExt;
use futures::StreamExt;
use sha2::Digest;
use sha2::Sha256;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::task::JoinSet;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::handshake::server::Response as UpgradeResponse;
use tokio_tungstenite::tungstenite::http::Response as HttpResponse;
use tokio_tungstenite::tungstenite::http::StatusCode;

use crate::DEFAULT_MAX_MESSAGE_BYTES;

const AUTHORIZATION: &str = "authorization";
const ORIGIN: &str = "origin";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const INBOUND_QUEUE_CAPACITY: usize = 1;
const OUTBOUND_QUEUE_CAPACITY: usize = 1;

/// A validated SHA-256 digest of one high-entropy WebSocket capability token.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityTokenSha256([u8; 32]);

impl CapabilityTokenSha256 {
    /// Decodes the exact 64-character lowercase or uppercase hexadecimal digest.
    pub fn from_hex(value: &str) -> io::Result<Self> {
        if value.len() != 64 {
            return Err(invalid_auth_config());
        }
        let mut digest = [0; 32];
        for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
            digest[index] = (decode_hex(pair[0])? << 4) | decode_hex(pair[1])?;
        }
        Ok(Self(digest))
    }

    fn authorizes(&self, authorization: Option<&str>) -> bool {
        let Some(token) = authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| !token.is_empty())
        else {
            return false;
        };
        let actual = Sha256::digest(token.as_bytes());
        constant_time_eq(&self.0, actual.as_slice())
    }
}

/// Parses the loopback-only WebSocket bind syntax accepted by the App Server host.
pub fn parse_loopback_websocket_bind(value: &str) -> io::Result<SocketAddr> {
    let address = value
        .strip_prefix("ws://")
        .ok_or_else(invalid_bind_address)
        .and_then(|address| SocketAddr::from_str(address).map_err(|_| invalid_bind_address()))?;
    if !address.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "App Server WebSocket listener must use a loopback address",
        ));
    }
    Ok(address)
}

/// A blocking JSON-lines reader backed by one authenticated WebSocket connection.
pub struct WebSocketReader {
    receiver: mpsc::Receiver<String>,
    buffered: Vec<u8>,
    offset: usize,
    disconnected: bool,
}

impl Read for WebSocketReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            if self.offset < self.buffered.len() {
                let available = &self.buffered[self.offset..];
                let length = available.len().min(output.len());
                output[..length].copy_from_slice(&available[..length]);
                self.offset += length;
                return Ok(length);
            }
            if self.disconnected {
                return Ok(0);
            }
            let Some(message) = self.receiver.blocking_recv() else {
                self.disconnected = true;
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "App Server WebSocket connection closed",
                ));
            };
            self.buffered = message.into_bytes();
            self.buffered.push(b'\n');
            self.offset = 0;
        }
    }
}

/// A blocking JSON-lines writer backed by one authenticated WebSocket connection.
pub struct WebSocketWriter {
    sender: mpsc::Sender<String>,
    buffered: Vec<u8>,
}

impl Write for WebSocketWriter {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        self.buffered.extend_from_slice(input);
        while let Some(newline) = self.buffered.iter().position(|byte| *byte == b'\n') {
            let mut frame = self.buffered.drain(..=newline).collect::<Vec<_>>();
            frame.pop();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            send_frame(&self.sender, frame)?;
        }
        if self.buffered.len() > DEFAULT_MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "App Server WebSocket message exceeds limit",
            ));
        }
        Ok(input.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A bound WebSocket listener and its process-owned accept task.
pub struct StartedWebSocketListener {
    address: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl StartedWebSocketListener {
    /// Returns the actual bound loopback address, including a generated port.
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// Stops accepting connections, closes active connections, and joins the accept task.
    pub async fn shutdown(mut self) -> io::Result<()> {
        let _ = self.shutdown.send(true);
        self.join().await
    }

    /// Runs until the listener fails or the process owner requests shutdown.
    pub async fn run_until<F>(mut self, shutdown: F) -> io::Result<()>
    where
        F: Future<Output = ()>,
    {
        let mut task = self
            .task
            .take()
            .expect("started WebSocket listener owns one accept task");
        tokio::select! {
            result = &mut task => join_task(result),
            () = shutdown => {
                let _ = self.shutdown.send(true);
                join_task(task.await)
            }
        }
    }

    async fn join(&mut self) -> io::Result<()> {
        let task = self
            .task
            .take()
            .expect("started WebSocket listener owns one accept task");
        join_task(task.await)
    }
}

impl Drop for StartedWebSocketListener {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Binds a loopback WebSocket listener and starts accepting authenticated connections.
pub async fn start_websocket_acceptor<H>(
    bind_address: SocketAddr,
    token_sha256: CapabilityTokenSha256,
    handler: H,
) -> io::Result<StartedWebSocketListener>
where
    H: Fn(WebSocketReader, WebSocketWriter) + Send + Sync + 'static,
{
    if !bind_address.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "App Server WebSocket listener must use a loopback address",
        ));
    }
    let listener = TcpListener::bind(bind_address).await?;
    let address = listener.local_addr()?;
    let (shutdown, shutdown_receiver) = watch::channel(false);
    let handler = Arc::new(handler);
    let task = tokio::spawn(run_accept_loop(
        listener,
        token_sha256,
        handler,
        shutdown_receiver,
    ));
    Ok(StartedWebSocketListener {
        address,
        shutdown,
        task: Some(task),
    })
}

async fn run_accept_loop<H>(
    listener: TcpListener,
    token_sha256: CapabilityTokenSha256,
    handler: Arc<H>,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()>
where
    H: Fn(WebSocketReader, WebSocketWriter) + Send + Sync + 'static,
{
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            result = listener.accept() => {
                let (stream, peer) = result?;
                if peer.ip().is_loopback() {
                    connections.spawn(run_connection(
                        stream,
                        token_sha256,
                        Arc::clone(&handler),
                        shutdown.clone(),
                    ));
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

async fn run_connection<H>(
    stream: TcpStream,
    token_sha256: CapabilityTokenSha256,
    handler: Arc<H>,
    shutdown: watch::Receiver<bool>,
) where
    H: Fn(WebSocketReader, WebSocketWriter) + Send + Sync + 'static,
{
    let callback = move |request: &Request, response: UpgradeResponse| {
        authorize_upgrade(request, response, token_sha256)
    };
    let Ok(Ok(websocket)) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, accept_hdr_async(stream, callback)).await
    else {
        return;
    };
    serve_websocket(websocket, handler, shutdown).await;
}

pub(crate) async fn serve_websocket<S, H>(
    mut websocket: tokio_tungstenite::WebSocketStream<S>,
    handler: Arc<H>,
    mut shutdown: watch::Receiver<bool>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    H: Fn(WebSocketReader, WebSocketWriter) + Send + Sync + 'static,
{
    if *shutdown.borrow() {
        return;
    }
    let (inbound_sender, inbound_receiver) = mpsc::channel(INBOUND_QUEUE_CAPACITY);
    let (outbound_sender, mut outbound_receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
    let (done_sender, mut done_receiver) = oneshot::channel();
    let reader = WebSocketReader {
        receiver: inbound_receiver,
        buffered: Vec::new(),
        offset: 0,
        disconnected: false,
    };
    let writer = WebSocketWriter {
        sender: outbound_sender,
        buffered: Vec::new(),
    };
    if thread::Builder::new()
        .name("ash-app-server-websocket".into())
        .spawn(move || {
            handler(reader, writer);
            let _ = done_sender.send(());
        })
        .is_err()
    {
        return;
    }

    let mut pending = None;
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = websocket.close(None).await;
                    break;
                }
            }
            _ = &mut done_receiver => {
                let _ = websocket.close(None).await;
                break;
            }
            permit = inbound_sender.reserve(), if pending.is_some() => {
                let Ok(permit) = permit else { break; };
                permit.send(pending.take().expect("pending frame owns a reserved queue slot"));
            }
            incoming = websocket.next(), if pending.is_none() => {
                match incoming {
                    Some(Ok(Message::Text(text)))
                        if text.len() <= DEFAULT_MAX_MESSAGE_BYTES =>
                    {
                        // Apply socket backpressure while keeping outbound responses
                        // and shutdown live. Ordinary startup bursts are not errors.
                        pending = Some(text.to_string());
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if websocket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Binary(_) | Message::Frame(_)))
                    | Some(Ok(Message::Text(_))) => {
                        let _ = websocket.close(None).await;
                        break;
                    }
                }
            }
            outgoing = outbound_receiver.recv() => {
                let Some(outgoing) = outgoing else {
                    let _ = websocket.close(None).await;
                    break;
                };
                if websocket.send(Message::Text(outgoing.into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

fn authorize_upgrade(
    request: &Request,
    response: UpgradeResponse,
    token_sha256: CapabilityTokenSha256,
) -> Result<UpgradeResponse, ErrorResponse> {
    if request.uri().path() != "/" || request.uri().query().is_some() {
        return Err(rejection(StatusCode::NOT_FOUND, "endpoint not found"));
    }
    if request.headers().contains_key(ORIGIN) {
        return Err(rejection(StatusCode::FORBIDDEN, "origin is not allowed"));
    }
    let authorization = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if !token_sha256.authorizes(authorization) {
        return Err(rejection(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(response)
}

fn rejection(status: StatusCode, message: &str) -> ErrorResponse {
    HttpResponse::builder()
        .status(status)
        .body(Some(message.into()))
        .expect("static WebSocket rejection must be valid")
}

fn send_frame(sender: &mpsc::Sender<String>, frame: Vec<u8>) -> io::Result<()> {
    if frame.len() > DEFAULT_MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "App Server WebSocket message exceeds limit",
        ));
    }
    let frame = String::from_utf8(frame).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "App Server WebSocket message is not UTF-8",
        )
    })?;
    sender.blocking_send(frame).map_err(|_| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            "App Server WebSocket connection closed",
        )
    })
}

fn decode_hex(value: u8) -> io::Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(invalid_auth_config()),
    }
}

fn constant_time_eq(expected: &[u8; 32], actual: &[u8]) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    expected
        .iter()
        .zip(actual)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn invalid_auth_config() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "WebSocket token digest must be exactly 32 bytes of hexadecimal",
    )
}

fn invalid_bind_address() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "App Server WebSocket address must be ws:// followed by a numeric socket address",
    )
}

fn join_task(result: Result<io::Result<()>, tokio::task::JoinError>) -> io::Result<()> {
    result.map_err(|error| io::Error::other(format!("WebSocket accept task failed: {error}")))?
}

#[cfg(test)]
#[path = "websocket_tests.rs"]
mod tests;
