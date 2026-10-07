use crate::WebSocketClientError;
use ash_http_client::HttpHeader;
use std::fmt;

/// A WebSocket handshake request with redacted header debug output.
#[derive(Clone, Eq, PartialEq)]
pub struct WebSocketRequest {
    url: String,
    headers: Vec<HttpHeader>,
}

impl WebSocketRequest {
    pub fn new(
        url: impl Into<String>,
        headers: Vec<HttpHeader>,
    ) -> Result<Self, WebSocketClientError> {
        for header in &headers {
            header.validate()?;
            if [
                "host",
                "connection",
                "upgrade",
                "sec-websocket-key",
                "sec-websocket-version",
                "sec-websocket-extensions",
            ]
            .iter()
            .any(|name| header.name().eq_ignore_ascii_case(name))
            {
                return Err(WebSocketClientError::InvalidRequest(
                    "caller cannot replace transport-owned handshake headers".into(),
                ));
            }
        }
        let url = url.into();
        let parsed = url::Url::parse(&url)
            .map_err(|_| WebSocketClientError::InvalidRequest("URL is invalid".into()))?;
        if !matches!(parsed.scheme(), "ws" | "wss") || parsed.host_str().is_none() {
            return Err(WebSocketClientError::InvalidRequest(
                "URL must use WS or WSS and include a host".into(),
            ));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(WebSocketClientError::InvalidRequest(
                "URL credentials are not allowed; use a redacted header".into(),
            ));
        }
        Ok(Self { url, headers })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn headers(&self) -> &[HttpHeader] {
        &self.headers
    }
}

impl fmt::Debug for WebSocketRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebSocketRequest")
            .field("url", &"[REDACTED]")
            .field("headers", &self.headers)
            .finish()
    }
}

/// Facts returned by a successful WebSocket upgrade.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebSocketHandshake {
    status: u16,
    headers: Vec<HttpHeader>,
}

impl WebSocketHandshake {
    pub(crate) fn new(status: u16, headers: Vec<HttpHeader>) -> Self {
        Self { status, headers }
    }

    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn headers(&self) -> &[HttpHeader] {
        &self.headers
    }
}
