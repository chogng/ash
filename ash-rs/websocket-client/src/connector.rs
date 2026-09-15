use crate::WebSocketClientConfig;
use crate::WebSocketClientError;
use crate::WebSocketHandshake;
use crate::WebSocketMessage;
use crate::WebSocketRequest;
use crate::dialer;
use ash_http_client::HttpHeader;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::Timeout;
use futures::SinkExt;
use futures::StreamExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Opens WebSocket connections using one immutable outbound network policy.
#[derive(Clone, Debug)]
pub struct WebSocketConnector {
    network: OutboundNetworkSnapshot,
    config: WebSocketClientConfig,
}

impl WebSocketConnector {
    pub fn new(network: OutboundNetworkSnapshot) -> Self {
        Self {
            network,
            config: WebSocketClientConfig::default(),
        }
    }

    pub fn with_config(mut self, config: WebSocketClientConfig) -> Self {
        self.config = config;
        self
    }

    pub async fn connect(
        &self,
        request: WebSocketRequest,
    ) -> Result<(WebSocketConnection, WebSocketHandshake), WebSocketClientError> {
        let mut wire_request = request
            .url()
            .into_client_request()
            .map_err(|_| WebSocketClientError::InvalidRequest("handshake URL is invalid".into()))?;
        for header in request.headers() {
            let name = tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(
                header.name().as_bytes(),
            )
            .map_err(|_| WebSocketClientError::InvalidRequest("header name is invalid".into()))?;
            let value = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(header.value())
                .map_err(|_| {
                    WebSocketClientError::InvalidRequest("header value is invalid".into())
                })?;
            wire_request.headers_mut().append(name, value);
        }
        let connect = dialer::connect(
            wire_request,
            self.config.tungstenite(),
            &self.network,
            self.config.tcp_no_delay(),
        );
        let (inner, response) = match self.network.timeouts().connect() {
            Timeout::Disabled => connect.await,
            Timeout::After(duration) => tokio::time::timeout(duration, connect)
                .await
                .map_err(|_| WebSocketClientError::ConnectionFailed)?,
        }?;
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| HttpHeader::new(name.as_str(), value))
            })
            .collect();
        Ok((
            WebSocketConnection { inner },
            WebSocketHandshake::new(response.status().as_u16(), headers),
        ))
    }
}

/// One established WebSocket with crate-owned send and receive messages.
pub struct WebSocketConnection {
    inner: dialer::RoutedWebSocket,
}

impl WebSocketConnection {
    pub async fn send(&mut self, message: WebSocketMessage) -> Result<(), WebSocketClientError> {
        self.inner
            .send(message.into_tungstenite())
            .await
            .map_err(|_| WebSocketClientError::ProtocolFailed)
    }

    pub async fn receive(&mut self) -> Result<WebSocketMessage, WebSocketClientError> {
        loop {
            let message = self
                .inner
                .next()
                .await
                .ok_or(WebSocketClientError::ConnectionClosed)?
                .map_err(|_| WebSocketClientError::ProtocolFailed)?;
            if let Some(message) = WebSocketMessage::from_tungstenite(message) {
                return Ok(message);
            }
        }
    }

    pub async fn close(
        mut self,
        frame: crate::WebSocketCloseFrame,
    ) -> Result<(), WebSocketClientError> {
        self.inner
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(
                    frame.code,
                ),
                reason: frame.reason.into(),
            }))
            .await
            .map_err(|_| WebSocketClientError::ProtocolFailed)
    }
}
