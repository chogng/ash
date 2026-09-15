use crate::ApiError;
use ash_async_utils::CancellationToken;
use ash_websocket_client::WebSocketConnection;
use ash_websocket_client::WebSocketConnector;
use ash_websocket_client::WebSocketHandshake;
use ash_websocket_client::WebSocketMessage;
use ash_websocket_client::WebSocketRequest;
use serde_json::Value;
use std::time::Duration;

/// Bounded JSON protocol I/O. Transport frame limits remain owned by the connector.
#[derive(Clone, Copy, Debug)]
pub struct WebSocketSessionConfig {
    pub idle_timeout: Duration,
    pub max_event_bytes: usize,
}
impl Default for WebSocketSessionConfig {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(60),
            max_event_bytes: 1024 * 1024,
        }
    }
}
impl WebSocketSessionConfig {
    pub(crate) fn validate(self) -> Result<(), ApiError> {
        if self.idle_timeout.is_zero() || self.max_event_bytes == 0 {
            return Err(ApiError::InvalidRequest(
                "WebSocket session limits must be positive".into(),
            ));
        }
        Ok(())
    }
}

pub(crate) struct JsonSocket {
    connection: WebSocketConnection,
    limits: WebSocketSessionConfig,
}
impl JsonSocket {
    pub(crate) async fn connect(
        connector: &WebSocketConnector,
        request: WebSocketRequest,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<(Self, WebSocketHandshake), ApiError> {
        limits.validate()?;
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled()),
            result = tokio::time::timeout(limits.idle_timeout, connector.connect(request)) => result,
        }.map_err(|_| timeout())?.map_err(map_error)?;
        Ok((
            Self {
                connection: result.0,
                limits,
            },
            result.1,
        ))
    }

    pub(crate) async fn shutdown(self, cancellation: &CancellationToken) -> Result<(), ApiError> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cancelled()),
            result = tokio::time::timeout(self.limits.idle_timeout, self.connection.close(ash_websocket_client::WebSocketCloseFrame { code: 1000, reason: String::new() })) => result.map_err(|_| timeout())?.map_err(map_error),
        }
    }

    pub(crate) async fn send(
        &mut self,
        value: Value,
        cancellation: &CancellationToken,
    ) -> Result<(), ApiError> {
        let text = serde_json::to_string(&value)
            .map_err(|_| ApiError::InvalidRequest("cannot encode WebSocket event".into()))?;
        if text.len() > self.limits.max_event_bytes {
            return Err(ApiError::InvalidRequest(
                "WebSocket event exceeds the configured limit".into(),
            ));
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cancelled()),
            result = tokio::time::timeout(self.limits.idle_timeout, self.connection.send(WebSocketMessage::Text(text))) => result.map_err(|_| timeout())?.map_err(map_error),
        }
    }

    pub(crate) async fn receive(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<Value, ApiError> {
        let mut deadline = tokio::time::Instant::now() + self.limits.idle_timeout;
        loop {
            let message = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(cancelled()),
                result = tokio::time::timeout_at(deadline, self.connection.receive()) => result.map_err(|_| timeout())?.map_err(map_error)?,
            };
            match message {
                WebSocketMessage::Text(text) => {
                    if text.len() > self.limits.max_event_bytes {
                        return Err(ApiError::InvalidResponse(
                            "WebSocket event exceeds the configured limit".into(),
                        ));
                    }
                    let value: Value = serde_json::from_str(&text).map_err(|_| {
                        ApiError::InvalidResponse("WebSocket event contains invalid JSON".into())
                    })?;
                    if !value.is_object() {
                        return Err(ApiError::InvalidResponse(
                            "WebSocket event must be an object".into(),
                        ));
                    }
                    return Ok(value);
                }
                WebSocketMessage::Ping(bytes) => {
                    deadline = tokio::time::Instant::now() + self.limits.idle_timeout;
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => return Err(cancelled()),
                        result = tokio::time::timeout_at(deadline, self.connection.send(WebSocketMessage::Pong(bytes))) => result.map_err(|_| timeout())?.map_err(map_error)?,
                    }
                }
                WebSocketMessage::Pong(_) => {
                    deadline = tokio::time::Instant::now() + self.limits.idle_timeout;
                }
                WebSocketMessage::Close(_) | WebSocketMessage::CloseWithoutFrame => {
                    return Err(ApiError::Transport(
                        "WebSocket closed before the operation completed".into(),
                    ));
                }
                WebSocketMessage::Binary(_) => {
                    return Err(ApiError::InvalidResponse(
                        "this endpoint requires JSON text WebSocket events".into(),
                    ));
                }
            }
        }
    }
}

pub(crate) fn url(base: &str, path: &str) -> Result<url::Url, ApiError> {
    let mut url = url::Url::parse(base)
        .map_err(|_| ApiError::InvalidRequest("invalid WebSocket service URL".into()))?;
    let scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => {
            return Err(ApiError::InvalidRequest(
                "unsupported WebSocket service scheme".into(),
            ));
        }
    };
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::InvalidRequest(
            "WebSocket service URLs cannot contain credentials, queries, or fragments".into(),
        ));
    }
    url.set_scheme(scheme)
        .map_err(|_| ApiError::InvalidRequest("invalid WebSocket service scheme".into()))?;
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), path));
    Ok(url)
}
fn timeout() -> ApiError {
    ApiError::Transport("WebSocket operation timed out".into())
}
pub(crate) fn cancelled() -> ApiError {
    ApiError::Cancelled("WebSocket operation cancelled".into())
}

fn map_error(error: ash_websocket_client::WebSocketClientError) -> ApiError {
    match error {
        ash_websocket_client::WebSocketClientError::HandshakeRejected(status) => {
            ApiError::HttpStatus(status)
        }
        ash_websocket_client::WebSocketClientError::InvalidRequest(_)
        | ash_websocket_client::WebSocketClientError::InvalidConfiguration(_) => {
            ApiError::InvalidRequest(error.to_string())
        }
        _ => ApiError::Transport(error.to_string()),
    }
}
