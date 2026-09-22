use futures::SinkExt;
use futures::StreamExt;
use opentelemetry_sdk::error::OTelSdkError;
use opentelemetry_sdk::error::OTelSdkResult;
use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::handshake::server::Response;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

const MAX_CONNECTIONS: usize = 8;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const PROTOCOL: &str = "ash-trace-v1";
const TOKEN_PREFIX: &str = "ash-trace-token.";

/// A 256-bit capability, supplied by the host and never written to the stream.
#[derive(Clone)]
pub struct AccessToken([u8; 32]);

impl fmt::Debug for AccessToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AccessToken([redacted])")
    }
}

impl FromStr for AccessToken {
    type Err = io::Error;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "trace token must contain 64 hexadecimal digits",
            ));
        }
        let mut bytes = [0; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap();
        }
        Ok(Self(bytes))
    }
}

impl AccessToken {
    fn matches(&self, text: &str) -> bool {
        let Ok(candidate) = text.parse::<Self>() else {
            return false;
        };
        self.0
            .iter()
            .zip(candidate.0)
            .fold(0, |difference, (left, right)| difference | (left ^ right))
            == 0
    }
}

#[derive(Debug)]
pub(super) struct Server {
    pub address: SocketAddr,
    stop: watch::Sender<bool>,
    worker: Mutex<Option<Worker>>,
}

#[derive(Debug)]
struct Worker {
    handle: thread::JoinHandle<()>,
    done: mpsc::Receiver<()>,
}

impl Server {
    pub fn bind(
        address: SocketAddr,
        token: AccessToken,
        frames: broadcast::Sender<Arc<str>>,
    ) -> io::Result<Self> {
        if !address.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "trace WebSocket requires a loopback address",
            ));
        }
        let listener = std::net::TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let listener = {
            let _entered = runtime.enter();
            TcpListener::from_std(listener)?
        };
        let (stop, receiver) = watch::channel(false);
        let (done_tx, done) = mpsc::channel();
        let stopped = stop.clone();
        let handle = thread::Builder::new()
            .name("ash-trace-websocket".into())
            .spawn(move || {
                runtime.block_on(serve(listener, token, frames, receiver));
                stopped.send_replace(true);
                drop(runtime);
                let _ = done_tx.send(());
            })?;
        Ok(Self {
            address,
            stop,
            worker: Mutex::new(Some(Worker { handle, done })),
        })
    }

    pub fn is_stopped(&self) -> bool {
        *self.stop.borrow()
    }

    pub fn shutdown(&self, timeout: Duration) -> OTelSdkResult {
        self.stop.send_replace(true);
        let mut worker = self.worker.lock().unwrap();
        if let Some(active) = worker.as_ref() {
            match active.done.recv_timeout(timeout) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(OTelSdkError::Timeout(timeout)),
            }
        }
        if let Some(active) = worker.take() {
            active.handle.join().map_err(|_| {
                OTelSdkError::InternalFailure("trace WebSocket worker panicked".into())
            })?;
        }
        Ok(())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(worker) = self.worker.get_mut().unwrap().take() {
            let _ = worker.handle.join();
        }
    }
}

async fn serve(
    listener: TcpListener,
    token: AccessToken,
    frames: broadcast::Sender<Arc<str>>,
    mut stop: watch::Receiver<bool>,
) {
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            Some(_) = clients.join_next() => {},
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                if clients.len() < MAX_CONNECTIONS {
                    clients.spawn(connection(stream, token.clone(), frames.clone()));
                }
            }
        }
    }
    clients.shutdown().await;
}

fn authorize(
    request: &Request,
    mut response: Response,
    token: &AccessToken,
) -> Result<Response, ErrorResponse> {
    let protocols: Vec<_> = request
        .headers()
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(',').map(str::trim))
        .collect();
    let header_token = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let browser_token = protocols
        .iter()
        .find_map(|value| value.strip_prefix(TOKEN_PREFIX));
    let authenticated = header_token.is_some_and(|value| token.matches(value))
        || (protocols.contains(&PROTOCOL)
            && browser_token.is_some_and(|value| token.matches(value)));
    if request.uri().path() != "/" || request.uri().query().is_some() || !authenticated {
        let mut rejected = ErrorResponse::new(Some("trace connection denied".into()));
        *rejected.status_mut() = StatusCode::UNAUTHORIZED;
        return Err(rejected);
    }
    if protocols.contains(&PROTOCOL) {
        response
            .headers_mut()
            .insert("sec-websocket-protocol", PROTOCOL.parse().unwrap());
    }
    Ok(response)
}

async fn connection(stream: TcpStream, token: AccessToken, frames: broadcast::Sender<Arc<str>>) {
    let config = WebSocketConfig::default()
        .write_buffer_size(0)
        .max_write_buffer_size(super::MAX_FRAME_BYTES + 1024)
        .max_message_size(Some(1024))
        .max_frame_size(Some(1024));
    let handshake = tokio_tungstenite::accept_hdr_async_with_config(
        stream,
        move |request: &Request, response| authorize(request, response, &token),
        Some(config),
    );
    let Ok(Ok(mut socket)) = tokio::time::timeout(IO_TIMEOUT, handshake).await else {
        return;
    };
    let mut receiver = frames.subscribe();
    if !matches!(
        tokio::time::timeout(
            IO_TIMEOUT,
            socket.send(Message::text(r#"{"type":"ready","version":1}"#))
        )
        .await,
        Ok(Ok(()))
    ) {
        return;
    }
    loop {
        let message = tokio::select! {
            frame = receiver.recv() => match frame {
                Ok(frame) => Message::text(frame.as_ref()),
                Err(broadcast::error::RecvError::Lagged(dropped)) => Message::text(
                    format!(r#"{{"type":"lagged","dropped":{dropped}}}"#)),
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Ping(bytes))) => Message::Pong(bytes),
                Some(Ok(Message::Pong(_))) => continue,
                _ => break,
            },
        };
        if !matches!(
            tokio::time::timeout(IO_TIMEOUT, socket.send(message)).await,
            Ok(Ok(()))
        ) {
            break;
        }
    }
}

#[cfg(test)]
#[path = "socket_tests.rs"]
mod tests;
