//! Local audio sessions. The default library contains only the pipe client and PCM contract.
//! Build the `host` feature for the separate device-owning executable.

mod client;
mod wire;

pub use client::AudioHost;
pub use wire::AudioConfig;
pub use wire::Capture;
pub use wire::CaptureState;
pub use wire::Direction;
pub use wire::Processing;
pub use wire::SampleRate;

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("audio host I/O failed")]
    Io(#[from] std::io::Error),
    #[error("invalid audio host protocol")]
    Protocol,
    #[error("audio host did not respond")]
    Timeout,
    #[error("audio session is not active")]
    Inactive,
    #[error("audio host rejected the operation: {0}")]
    Rejected(String),
}

// The executable uses the same codec as the client; this module is not a device abstraction.
#[cfg(feature = "host")]
#[doc(hidden)]
pub mod server;
