use std::io;

use crate::HostErrorCode;

/// Sanitized failure produced by the Editor Extension Host boundary.
#[derive(Debug, thiserror::Error)]
pub enum ExtensionHostError {
    #[error("extension activation authority is no longer valid")]
    AuthorityDenied,
    #[error("extension host entered its crash-loop limit")]
    CrashLoop,
    #[error("extension host hard resource isolation is unavailable")]
    IsolationUnavailable,
    #[error("extension host limits are invalid: {0}")]
    InvalidLimits(&'static str),
    #[error("extension host protocol message is invalid: {0}")]
    InvalidProtocol(String),
    #[error("extension host quota exceeded: {0}")]
    QuotaExceeded(&'static str),
    #[error("extension host request timed out")]
    RequestTimedOut,
    #[error("extension host exhausted its request identity space")]
    RequestIdentityExhausted,
    #[error("extension host registration was not found")]
    RegistrationNotFound,
    #[error("extension host rejected the request ({code:?}): {message}")]
    HostRejected {
        code: HostErrorCode,
        message: String,
    },
    #[error("extension host restarted before the request completed")]
    HostRestarted,
    #[error("extension host exited before the request completed")]
    HostExited,
    #[error("extension host operation outcome is indeterminate")]
    OutcomeIndeterminate,
    #[error("extension host startup timed out")]
    StartupTimedOut,
    #[error("extension host process could not be started")]
    SpawnFailed,
    #[error("extension host shutdown timed out")]
    ShutdownTimedOut,
    #[error("extension host transport failed")]
    Transport(#[source] io::Error),
}

impl From<io::Error> for ExtensionHostError {
    fn from(error: io::Error) -> Self {
        Self::Transport(error)
    }
}

impl From<external_ext_protocol::ProtocolError> for ExtensionHostError {
    fn from(error: external_ext_protocol::ProtocolError) -> Self {
        match error {
            external_ext_protocol::ProtocolError::InvalidProtocol(message) => {
                Self::InvalidProtocol(message)
            }
            external_ext_protocol::ProtocolError::QuotaExceeded(quota) => {
                Self::QuotaExceeded(quota)
            }
            external_ext_protocol::ProtocolError::Transport(error) => Self::Transport(error),
        }
    }
}
