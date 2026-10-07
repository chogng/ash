//! Provider-neutral WebSocket connection transport for Ash model clients.
//!
//! This crate owns handshake, proxy/TLS routing, bounded frames, and raw
//! WebSocket messages. Provider event JSON, session state, fallback, and retry
//! remain in protocol and operation layers above it.

mod config;
mod connector;
mod dialer;
mod error;
mod message;
mod request;

pub use config::{TcpNoDelay, WebSocketClientConfig, WebSocketLimits};
pub use connector::{WebSocketConnection, WebSocketConnector};
pub use error::WebSocketClientError;
pub use message::{WebSocketCloseFrame, WebSocketMessage};
pub use request::{WebSocketHandshake, WebSocketRequest};

#[cfg(test)]
#[path = "websocket_client_tests.rs"]
mod tests;
