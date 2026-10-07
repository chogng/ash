use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::HttpRequest;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::UreqHttpClient;
use ash_websocket_client::WebSocketClientError;
use ash_websocket_client::WebSocketCloseFrame;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketMessage;
use ash_websocket_client::WebSocketRequest;
use livekit_net::TransportError;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::time::timeout;

const IO_TIMEOUT: Duration = Duration::from_secs(10);

static INSTALL: OnceLock<Result<(), ()>> = OnceLock::new();

pub(crate) fn install() -> Result<(), crate::MediaError> {
    match INSTALL.get_or_init(|| {
        let network = OutboundNetworkSnapshot::new(HttpClientConfig::default()).map_err(|_| ())?;
        let client = client(network).map_err(|_| ())?;
        livekit_net::set_http_client(client.clone());
        livekit_net::set_ws_client(client);
        Ok(())
    }) {
        Ok(()) => Ok(()),
        Err(()) => Err(crate::MediaError::Connection),
    }
}

fn client(network: OutboundNetworkSnapshot) -> Result<Arc<Client>, crate::MediaError> {
    let http =
        UreqHttpClient::with_network(network.clone()).map_err(|_| crate::MediaError::Connection)?;
    Ok(Arc::new(Client {
        http: Arc::new(http),
        websocket: WebSocketConnector::new(network),
    }))
}

struct Client {
    http: Arc<UreqHttpClient>,
    websocket: WebSocketConnector,
}

fn headers(values: Vec<livekit_net::Header>) -> Vec<HttpHeader> {
    values
        .into_iter()
        .map(|header| HttpHeader::new(header.name, header.value))
        .collect()
}

#[async_trait::async_trait]
impl livekit_net::HttpClient for Client {
    async fn request(
        &self,
        method: livekit_net::HttpMethod,
        url: String,
        fields: Vec<livekit_net::Header>,
        body: Option<Vec<u8>>,
    ) -> Result<livekit_net::HttpResponse, TransportError> {
        let method = match method {
            livekit_net::HttpMethod::Get => ash_http_client::HttpMethod::Get,
            livekit_net::HttpMethod::Post => ash_http_client::HttpMethod::Post,
        };
        let request = HttpRequest::new(method, url, headers(fields), body.unwrap_or_default())
            .map_err(|_| TransportError::Other("invalid media HTTP request".into()))?;
        let client = self.http.clone();
        let response = tokio::task::spawn_blocking(move || client.execute(&request))
            .await
            .map_err(|_| TransportError::Closed)?
            .map_err(|_| TransportError::Connection("media HTTP request failed".into()))?;
        Ok(livekit_net::HttpResponse {
            status: response.status(),
            headers: response
                .headers()
                .iter()
                .map(|header| livekit_net::Header {
                    name: header.name().into(),
                    value: header.value().into(),
                })
                .collect(),
            body: response.body().to_vec(),
        })
    }
}

fn wire_error(error: WebSocketClientError) -> TransportError {
    match error {
        WebSocketClientError::HandshakeRejected(status) => TransportError::Http { status },
        WebSocketClientError::ConnectionClosed => TransportError::Closed,
        _ => TransportError::Connection("media WebSocket failed".into()),
    }
}

enum Command {
    Send(Vec<u8>, oneshot::Sender<Result<(), TransportError>>),
    Close(oneshot::Sender<()>),
}

struct Connection {
    commands: mpsc::Sender<Command>,
    incoming: Mutex<mpsc::Receiver<Result<Vec<u8>, TransportError>>>,
    worker: tokio::task::AbortHandle,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

#[async_trait::async_trait]
impl livekit_net::WsClient for Client {
    async fn connect(
        &self,
        url: String,
        fields: Vec<livekit_net::Header>,
        timeout_ms: u64,
    ) -> Result<livekit_net::WsConnectResult, TransportError> {
        let request = WebSocketRequest::new(url, headers(fields)).map_err(wire_error)?;
        let (mut socket, _) = timeout(
            Duration::from_millis(timeout_ms),
            self.websocket.connect(request),
        )
        .await
        .map_err(|_| TransportError::Timeout)?
        .map_err(wire_error)?;
        let (commands, mut outgoing) = mpsc::channel::<Command>(32);
        let (incoming, received) = mpsc::channel(64);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    command = outgoing.recv() => match command {
                        Some(Command::Send(frame, reply)) => {
                            let result = timeout(IO_TIMEOUT, socket.send(WebSocketMessage::Binary(frame))).await.map_err(|_| TransportError::Timeout).and_then(|result| result.map_err(wire_error));
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed { break; }
                        }
                        Some(Command::Close(reply)) => {
                            let _ = timeout(IO_TIMEOUT, socket.close(WebSocketCloseFrame { code: 1000, reason: String::new() })).await;
                            let _ = reply.send(());
                            break;
                        }
                        None => break,
                    },
                    message = socket.receive() => match message {
                        Ok(WebSocketMessage::Binary(frame)) => {
                            if incoming.try_send(Ok(frame)).is_err() { break; }
                        }
                        Ok(WebSocketMessage::Ping(payload)) => {
                            if !matches!(timeout(IO_TIMEOUT, socket.send(WebSocketMessage::Pong(payload))).await, Ok(Ok(()))) { break; }
                        }
                        Ok(WebSocketMessage::Close(_) | WebSocketMessage::CloseWithoutFrame) => break,
                        Ok(_) => {},
                        Err(error) => { let _ = incoming.try_send(Err(wire_error(error))); break; }
                    }
                }
            }
        });
        let worker = task.abort_handle();
        Ok(livekit_net::WsConnectResult {
            connection: Arc::new(Connection {
                commands,
                incoming: Mutex::new(received),
                worker,
            }),
        })
    }
}

#[async_trait::async_trait]
impl livekit_net::WsConnection for Connection {
    async fn send(&self, frame: Vec<u8>) -> Result<(), TransportError> {
        let (reply, result) = oneshot::channel();
        timeout(IO_TIMEOUT, async {
            self.commands
                .send(Command::Send(frame, reply))
                .await
                .map_err(|_| TransportError::Closed)?;
            result.await.map_err(|_| TransportError::Closed)?
        })
        .await
        .map_err(|_| TransportError::Timeout)?
    }
    async fn recv(&self) -> Result<Option<Vec<u8>>, TransportError> {
        self.incoming.lock().await.recv().await.transpose()
    }
    async fn close(&self) {
        let (reply, closed) = oneshot::channel();
        let _ = timeout(IO_TIMEOUT, async {
            let _ = self.commands.send(Command::Close(reply)).await;
            let _ = closed.await;
        })
        .await;
        self.worker.abort();
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
