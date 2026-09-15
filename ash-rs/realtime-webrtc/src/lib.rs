//! Provider-neutral WebRTC transport for mono PCM16 audio at 48 kHz.
//! Device ownership and service authentication belong to callers.

mod peer;
mod playout;

pub use peer::ConnectionState;
pub use peer::DataChannel;
pub use peer::Network;
pub use peer::PeerConfig;
pub use peer::PeerEvent;
pub use peer::VoicePeer;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("invalid voice transport configuration or input")]
    InvalidInput,
    #[error("voice transport operation failed")]
    Connection,
    #[error("voice transport operation timed out")]
    Timeout,
    #[error("voice codec failed")]
    Codec,
    #[error("voice consumer did not keep up")]
    Backpressure,
}
