use std::num::NonZeroUsize;

/// Bounded inbound WebSocket message and frame sizes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WebSocketLimits {
    max_message_bytes: NonZeroUsize,
    max_frame_bytes: NonZeroUsize,
}

impl WebSocketLimits {
    pub const fn new(max_message_bytes: NonZeroUsize, max_frame_bytes: NonZeroUsize) -> Self {
        Self {
            max_message_bytes,
            max_frame_bytes,
        }
    }

    pub const fn max_message_bytes(self) -> NonZeroUsize {
        self.max_message_bytes
    }

    pub const fn max_frame_bytes(self) -> NonZeroUsize {
        self.max_frame_bytes
    }
}

impl Default for WebSocketLimits {
    fn default() -> Self {
        Self::new(
            NonZeroUsize::new(16 * 1024 * 1024).expect("sixteen MiB is non-zero"),
            NonZeroUsize::new(2 * 1024 * 1024).expect("two MiB is non-zero"),
        )
    }
}

/// Selects whether latency-sensitive connections disable Nagle's algorithm.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TcpNoDelay {
    #[default]
    SystemDefault,
    Enabled,
}

/// Immutable configuration for a reusable WebSocket connector.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WebSocketClientConfig {
    limits: WebSocketLimits,
    tcp_no_delay: TcpNoDelay,
}

impl WebSocketClientConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_limits(mut self, limits: WebSocketLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn with_tcp_no_delay(mut self, tcp_no_delay: TcpNoDelay) -> Self {
        self.tcp_no_delay = tcp_no_delay;
        self
    }

    pub const fn limits(self) -> WebSocketLimits {
        self.limits
    }

    pub const fn tcp_no_delay(self) -> TcpNoDelay {
        self.tcp_no_delay
    }

    pub(crate) fn tungstenite(self) -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        config.max_message_size = Some(self.limits.max_message_bytes.get());
        config.max_frame_size = Some(self.limits.max_frame_bytes.get());
        config
    }
}
