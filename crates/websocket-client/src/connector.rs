use crate::WebSocketClientConfig;
use crate::WebSocketClientError;
use crate::WebSocketHandshake;
use crate::WebSocketMessage;
use crate::WebSocketRequest;
use crate::dialer;
use ash_http_client::HttpHeader;
use ash_http_client::NetworkPermit;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::Timeout;
use futures::SinkExt;
use futures::StreamExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Opens WebSocket connections using shared transport settings and a live host policy.
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
        let url = request.url().to_owned();
        let permit = self.network.policy().acquire(&url)?;
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
        let dial = async {
            match self.network.timeouts().connect() {
                Timeout::Disabled => connect.await,
                Timeout::After(duration) => tokio::time::timeout(duration, connect)
                    .await
                    .map_err(|_| WebSocketClientError::ConnectionFailed)?,
            }
        };
        let (inner, response) = tokio::select! {
            biased;
            () = permit.revoked() => return Err(WebSocketClientError::ConnectionClosed),
            result = dial => result?,
        };
        permit.check()?;
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
            WebSocketConnection { inner, permit },
            WebSocketHandshake::new(response.status().as_u16(), headers),
        ))
    }
}

/// One established WebSocket with crate-owned send and receive messages.
pub struct WebSocketConnection {
    inner: dialer::RoutedWebSocket,
    permit: NetworkPermit,
}

impl WebSocketConnection {
    pub async fn send(&mut self, message: WebSocketMessage) -> Result<(), WebSocketClientError> {
        if self.permit.check().is_err() {
            return Err(WebSocketClientError::ConnectionClosed);
        }
        let result = tokio::select! {
            biased;
            () = self.permit.revoked() => Err(WebSocketClientError::ConnectionClosed),
            result = self.inner.send(message.into_tungstenite()) => result.map_err(|_| WebSocketClientError::ProtocolFailed),
        };
        if self.permit.check().is_err() {
            return Err(WebSocketClientError::ConnectionClosed);
        }
        result
    }

    pub async fn receive(&mut self) -> Result<WebSocketMessage, WebSocketClientError> {
        loop {
            if self.permit.check().is_err() {
                return Err(WebSocketClientError::ConnectionClosed);
            }
            let next = tokio::select! {
                biased;
                () = self.permit.revoked() => return Err(WebSocketClientError::ConnectionClosed),
                result = self.inner.next() => result,
            };
            let message = next
                .ok_or(WebSocketClientError::ConnectionClosed)?
                .map_err(|_| WebSocketClientError::ProtocolFailed)?;
            if let Some(message) = WebSocketMessage::from_tungstenite(message) {
                if self.permit.check().is_err() {
                    return Err(WebSocketClientError::ConnectionClosed);
                }
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
