//! TCP byte streams over a verified HTTP/3 CONNECT proxy.
//!
//! [`ProxyClient`] owns the connection and every subordinate task. It does not read
//! process I/O, manage accounts, or retry traffic. Use [`ProxyClient::close`] to join
//! cleanup while keeping the caller's Tokio runtime alive.
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Context;
use std::task::Poll;

use async_utils::CancelOnDrop;
use async_utils::CancellationSource;
use async_utils::CancellationToken;
use bytes::Buf;
use bytes::Bytes;
use http::Method;
use http::Request;
use http::StatusCode;
use http::Uri;
use quinn::crypto::rustls::QuicClientConfig;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::DuplexStream;
use tokio::io::ReadBuf;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::task::JoinSet;
use tokio::time::timeout;

mod config;
mod forward;

pub use config::ConnectTarget;
pub use config::Credentials;
pub use config::ProxyConfig;
pub use forward::ForwardEvent;
pub use forward::LocalForward;

/// Stable, credential-safe failures; raw peer messages and header values are excluded.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    InvalidInput(&'static str),
    #[error("proxy origin is not approved")]
    UntrustedProxy,
    #[error("TLS configuration failed")]
    TlsConfiguration,
    #[error("proxy name resolution failed")]
    Resolution,
    #[error("proxy connection failed")]
    Connection,
    #[error("proxy connection timed out")]
    ConnectionTimeout,
    #[error("CONNECT response timed out")]
    RequestTimeout,
    #[error("CONNECT rejected with HTTP {0}")]
    Rejected(StatusCode),
    #[error("proxy is draining")]
    Draining,
    #[error("proxy rejected CONNECT before processing it")]
    RequestRejected,
    #[error("HTTP/3 transport failed")]
    Transport,
    #[error("proxy client is closed")]
    Closed,
    #[error("operation cancelled")]
    Cancelled,
    #[error("local TCP I/O failed")]
    LocalIo,
    #[error("tunnel task failed")]
    Task,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Draining is observed when the proxy refuses a new request after GOAWAY.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Connected,
    Draining,
    Closed(Error),
}

const BUFFER_BYTES: usize = 64 * 1024;
type HttpSender = h3::client::SendRequest<h3_quinn::OpenStreams, Bytes>;
type HttpStream = h3::client::RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>;

/// One connection owner. Dropping it requests cleanup; `close().await` waits for it.
///
/// A connection is multiplexed across targets. Reconnection belongs to the caller:
/// neither failed CONNECT requests nor established TCP bytes are replayed.
pub struct ProxyClient {
    requests: Requests,
    state: watch::Receiver<ConnectionState>,
    owner: JoinHandle<()>,
    _cancel_on_drop: CancelOnDrop,
}

#[derive(Clone)]
struct Requests {
    commands: mpsc::Sender<Command>,
    credentials: Arc<Mutex<Credentials>>,
    cancellation: CancellationToken,
}

enum Command {
    Open {
        target: ConnectTarget,
        credentials: Credentials,
        source: CancellationSource,
        caller: CancellationToken,
        reply: oneshot::Sender<Result<TunnelStream>>,
    },
    Listen {
        listener: TcpListener,
        target: ConnectTarget,
        source: CancellationSource,
        events: tokio::sync::broadcast::Sender<ForwardEvent>,
        finished: oneshot::Sender<Result<()>>,
    },
}

enum Completed {
    Driver,
    Stream,
    Forward,
}

impl ProxyClient {
    /// Establishes TLS/QUIC and HTTP/3, without contacting any TCP target.
    ///
    /// The token governs this client's lifetime, including its streams and listeners.
    pub async fn connect(
        config: ProxyConfig,
        credentials: Credentials,
        cancellation: CancellationToken,
    ) -> Result<Self> {
        let source = cancellation.child_source();
        let guard = source.cancel_on_drop();
        let token = source.token();
        let connected = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(Error::Cancelled),
            result = timeout(config.connect_timeout, connect_proxy(&config)) => {
                result.map_err(|_| Error::ConnectionTimeout)??
            }
        };
        let (commands, incoming) = mpsc::channel(64);
        let requests = Requests {
            commands,
            credentials: Arc::new(Mutex::new(credentials)),
            cancellation: token.clone(),
        };
        let (state, state_receiver) = watch::channel(ConnectionState::Connected);
        let owner = tokio::spawn(own_connection(
            connected,
            incoming,
            requests.clone(),
            state,
            source,
            config.request_timeout,
        ));
        Ok(Self {
            requests,
            state: state_receiver,
            owner,
            _cancel_on_drop: guard,
        })
    }

    /// Returns a bounded AsyncRead/AsyncWrite stream only after a successful CONNECT.
    /// The token also cancels the returned stream; dropping this future cancels setup.
    pub async fn open_stream(
        &self,
        target: ConnectTarget,
        cancellation: CancellationToken,
    ) -> Result<TunnelStream> {
        self.requests.open(target, cancellation).await
    }

    /// Replaces credentials for requests submitted after this method returns.
    /// Existing streams keep their established authorization.
    pub fn update_credentials(&self, credentials: Credentials) -> Result<()> {
        if self.requests.cancellation.is_cancelled() {
            return Err(Error::Closed);
        }
        *self
            .requests
            .credentials
            .lock()
            .expect("credential lock poisoned") = credentials;
        Ok(())
    }

    pub fn state(&self) -> ConnectionState {
        self.state.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<ConnectionState> {
        self.state.clone()
    }

    /// Starts a loopback listener. This does not establish the target TCP connection.
    /// Each accepted socket gets its own CONNECT; failures are exposed as typed events.
    pub async fn listen_loopback(
        &self,
        target: ConnectTarget,
        address: SocketAddr,
    ) -> Result<LocalForward> {
        if !address.ip().is_loopback() {
            return Err(Error::InvalidInput("listener must be loopback"));
        }
        let source = self.requests.cancellation.child_source();
        let guard = source.cancel_on_drop();
        let token = source.token();
        let listener = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(Error::Closed),
            result = TcpListener::bind(address) => result.map_err(|_| Error::LocalIo)?,
        };
        let address = listener.local_addr().map_err(|_| Error::LocalIo)?;
        let (events, _) = tokio::sync::broadcast::channel(64);
        let (finished, completion) = oneshot::channel();
        let command = Command::Listen {
            listener,
            target,
            source: source.clone(),
            events: events.clone(),
            finished,
        };
        tokio::select! {
            biased;
            _ = token.cancelled() => return Err(Error::Closed),
            result = self.requests.commands.send(command) => result.map_err(|_| Error::Closed)?,
        }
        Ok(LocalForward::new(
            address, source, guard, events, completion,
        ))
    }

    /// Cancels this client's tasks and joins their cleanup. The runtime stays usable.
    pub async fn close(self) -> Result<()> {
        // The guard owns the same cancellation domain as `requests`.
        drop(self._cancel_on_drop);
        self.owner.await.map_err(|_| Error::Task)
    }
}

impl Requests {
    async fn open(&self, target: ConnectTarget, caller: CancellationToken) -> Result<TunnelStream> {
        let source = self.cancellation.child_source();
        let guard = source.cancel_on_drop();
        let token = source.token();
        let credentials = self
            .credentials
            .lock()
            .expect("credential lock poisoned")
            .clone();
        let (reply, response) = oneshot::channel();
        let command = Command::Open {
            target,
            credentials,
            source,
            caller: caller.clone(),
            reply,
        };
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => Err(Error::Closed),
            _ = caller.cancelled() => Err(Error::Cancelled),
            result = async {
                self.commands.send(command).await.map_err(|_| Error::Closed)?;
                response.await.map_err(|_| Error::Closed)?
            } => result,
        };
        if result.is_ok() {
            guard.disarm();
        }
        result
    }
}

struct Connected {
    endpoint: quinn::Endpoint,
    quic: quinn::Connection,
    driver: h3::client::Connection<h3_quinn::Connection, Bytes>,
    sender: HttpSender,
}

async fn connect_proxy(config: &ProxyConfig) -> Result<Connected> {
    let host = config
        .origin
        .host_str()
        .expect("validated proxy origin has a host");
    // URL host_str brackets IPv6 literals; TLS and lookup_host require the bare address.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = config
        .origin
        .port_or_known_default()
        .expect("HTTPS origin has a port");
    let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| Error::TlsConfiguration)?
    .with_root_certificates(config.roots.clone())
    .with_no_client_auth();
    tls.alpn_protocols = vec![b"h3".to_vec()];
    let mut client_config = quinn::ClientConfig::new(Arc::new(
        QuicClientConfig::try_from(tls).map_err(|_| Error::TlsConfiguration)?,
    ));
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(std::time::Duration::from_secs(10)));
    transport.max_idle_timeout(Some(
        std::time::Duration::from_secs(30)
            .try_into()
            .map_err(|_| Error::TlsConfiguration)?,
    ));
    client_config.transport_config(Arc::new(transport));
    let peers = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| Error::Resolution)?;
    for peer in peers {
        let bind = if peer.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let mut endpoint = quinn::Endpoint::client(bind.parse().expect("valid UDP bind address"))
            .map_err(|_| Error::Connection)?;
        endpoint.set_default_client_config(client_config.clone());
        let connecting = endpoint
            .connect(peer, host)
            .map_err(|_| Error::Connection)?;
        let Ok(quic) = connecting.await else { continue };
        let (driver, sender) = h3::client::builder()
            .build(h3_quinn::Connection::new(quic.clone()))
            .await
            .map_err(|_| Error::Transport)?;
        return Ok(Connected {
            endpoint,
            quic,
            driver,
            sender,
        });
    }
    Err(Error::Connection)
}

async fn own_connection(
    connected: Connected,
    mut incoming: mpsc::Receiver<Command>,
    requests: Requests,
    state: watch::Sender<ConnectionState>,
    source: CancellationSource,
    request_timeout: std::time::Duration,
) {
    let token = source.token();
    let Connected {
        endpoint,
        quic,
        mut driver,
        sender,
    } = connected;
    let mut tasks = JoinSet::new();
    tasks.spawn(async move {
        driver.wait_idle().await;
        Completed::Driver
    });
    let terminal = loop {
        tokio::select! {
            biased;
            _ = token.cancelled() => break Error::Closed,
            _ = quic.closed() => break Error::Transport,
            result = tasks.join_next(), if !tasks.is_empty() => match result {
                Some(Ok(Completed::Driver)) => break Error::Transport,
                Some(Err(_)) => break Error::Task,
                Some(Ok(Completed::Stream | Completed::Forward)) | None => {},
            },
            command = incoming.recv() => match command {
                Some(Command::Open { target, credentials, source, caller, reply }) => {
                    if *state.borrow() == ConnectionState::Draining {
                        let _ = reply.send(Err(Error::Draining));
                        continue;
                    }
                    let sender = sender.clone();
                    let state = state.clone();
                    tasks.spawn(async move {
                        run_stream(sender, target, credentials, source, caller, reply, state, request_timeout).await;
                        Completed::Stream
                    });
                }
                Some(Command::Listen { listener, target, source, events, finished }) => {
                    let requests = requests.clone();
                    tasks.spawn(async move {
                        let result = forward::serve(listener, target, requests, source.token(), events).await;
                        let _ = finished.send(result);
                        Completed::Forward
                    });
                }
                None => break Error::Closed,
            },
        }
    };
    state.send_replace(ConnectionState::Closed(terminal));
    // Cancel descendants before joining: listeners may be awaiting new commands and
    // streams may be stalled on application backpressure. QUIC closure alone is insufficient.
    source.cancel();
    endpoint.close(0_u8.into(), b"closed");
    incoming.close();
    while let Some(command) = incoming.recv().await {
        match command {
            Command::Open { reply, .. } => {
                let _ = reply.send(Err(Error::Closed));
            }
            Command::Listen {
                listener, finished, ..
            } => {
                drop(listener);
                let _ = finished.send(Ok(()));
            }
        }
    }
    while tasks.join_next().await.is_some() {}
    endpoint.wait_idle().await;
}

async fn run_stream(
    mut sender: HttpSender,
    target: ConnectTarget,
    credentials: Credentials,
    source: CancellationSource,
    caller: CancellationToken,
    mut reply: oneshot::Sender<Result<TunnelStream>>,
    state: watch::Sender<ConnectionState>,
    deadline: std::time::Duration,
) {
    let token = source.token();
    let opening = async {
        let mut request = Request::builder()
            .method(Method::CONNECT)
            .uri(
                Uri::builder()
                    .authority(target.0)
                    .build()
                    .map_err(|_| Error::InvalidInput("invalid CONNECT target"))?,
            )
            .body(())
            .map_err(|_| Error::InvalidInput("invalid CONNECT request"))?;
        *request.headers_mut() = credentials.headers;
        let mut stream = sender.send_request(request).await.map_err(stream_error)?;
        let status = loop {
            let status = stream.recv_response().await.map_err(stream_error)?.status();
            if !status.is_informational() {
                break status;
            }
        };
        if !status.is_success() {
            stream.stop_stream(h3::error::Code::H3_REQUEST_CANCELLED);
            return Err(Error::Rejected(status));
        }
        Ok(stream)
    };
    let opened = tokio::select! {
        biased;
        _ = token.cancelled() => Err(Error::Cancelled),
        _ = caller.cancelled() => Err(Error::Cancelled),
        _ = reply.closed() => return,
        result = timeout(deadline, opening) => result.unwrap_or(Err(Error::RequestTimeout)),
    };
    let stream = match opened {
        Ok(stream) => stream,
        Err(error) => {
            if error == Error::Draining {
                state.send_if_modified(|state| {
                    if *state == ConnectionState::Connected {
                        *state = ConnectionState::Draining;
                        true
                    } else {
                        false
                    }
                });
            }
            let _ = reply.send(Err(error));
            return;
        }
    };
    let (local, mut bridge) = tokio::io::duplex(BUFFER_BYTES);
    let outcome = Arc::new(Mutex::new(None));
    let stream_guard = source.cancel_on_drop();
    let (finished, completion) = oneshot::channel();
    if reply
        .send(Ok(TunnelStream {
            local,
            outcome: outcome.clone(),
            finished: completion,
            _cancel_on_drop: stream_guard,
        }))
        .is_err()
    {
        return;
    }
    let result = transfer(&mut bridge, stream, token, caller, &state).await;
    *outcome.lock().expect("stream outcome lock poisoned") = result.err();
    drop(bridge);
    let _ = finished.send(());
}

fn stream_error(error: h3::error::StreamError) -> Error {
    match error {
        h3::error::StreamError::RemoteClosing { .. } => Error::Draining,
        h3::error::StreamError::RemoteTerminate {
            code: h3::error::Code::H3_REQUEST_REJECTED,
            ..
        } => Error::RequestRejected,
        _ => Error::Transport,
    }
}

async fn transfer(
    bridge: &mut DuplexStream,
    stream: HttpStream,
    token: CancellationToken,
    caller: CancellationToken,
    state: &watch::Sender<ConnectionState>,
) -> Result<()> {
    let (mut send, mut recv) = stream.split();
    let (mut read, mut write) = tokio::io::split(bridge);
    let upload = async {
        let mut buffer = vec![0; BUFFER_BYTES];
        loop {
            let count = read.read(&mut buffer).await.map_err(|_| Error::LocalIo)?;
            if count == 0 {
                send.finish().await.map_err(stream_error)?;
                return Ok(());
            }
            send.send_data(Bytes::copy_from_slice(&buffer[..count]))
                .await
                .map_err(stream_error)?;
        }
    };
    let download = async {
        while let Some(mut data) = recv.recv_data().await.map_err(stream_error)? {
            while data.has_remaining() {
                let chunk = data.chunk();
                write.write_all(chunk).await.map_err(|_| Error::LocalIo)?;
                data.advance(chunk.len());
            }
        }
        write.shutdown().await.map_err(|_| Error::LocalIo)?;
        Ok(())
    };
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => match &*state.borrow() {
            ConnectionState::Closed(error) => Err(error.clone()),
            ConnectionState::Connected | ConnectionState::Draining => Err(Error::Cancelled),
        },
        _ = caller.cancelled() => Err(Error::Cancelled),
        result = async { tokio::try_join!(upload, download).map(|_| ()) } => result,
    };
    if result.is_err() {
        send.stop_stream(h3::error::Code::H3_REQUEST_CANCELLED);
        // Dropping the receive half also drops its in-flight Quinn read. Calling
        // stop_sending after cancelling recv_data is invalid in this h3-quinn revision.
    }
    result
}

/// A bounded TCP-like stream. Write shutdown sends FIN; reads remain available.
/// Dropping the stream cancels only its own request, leaving siblings usable.
pub struct TunnelStream {
    local: DuplexStream,
    outcome: Arc<Mutex<Option<Error>>>,
    finished: oneshot::Receiver<()>,
    _cancel_on_drop: CancelOnDrop,
}

impl TunnelStream {
    /// Cancels both directions and waits for this stream's HTTP/3 task to release them.
    pub async fn close(self) -> Result<()> {
        drop(self._cancel_on_drop);
        self.finished.await.map_err(|_| Error::Task)
    }

    fn failure(&self) -> Option<io::Error> {
        self.outcome
            .lock()
            .expect("stream outcome lock poisoned")
            .clone()
            .map(io::Error::other)
    }
}

impl AsyncRead for TunnelStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        match Pin::new(&mut self.local).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) if before == buffer.filled().len() => {
                Poll::Ready(self.failure().map_or(Ok(()), Err))
            }
            result => result,
        }
    }
}

impl AsyncWrite for TunnelStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(error) = self.failure() {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.local).poll_write(cx, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(error) = self.failure() {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.local).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(error) = self.failure() {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut self.local).poll_shutdown(cx)
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
