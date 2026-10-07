use std::time::Duration;

/// Failures produced while starting, using, or shutting down an MCP client session.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RmcpClientError {
    #[error("failed to start MCP transport: {0}")]
    TransportStart(#[source] std::io::Error),
    #[error("MCP initialize timed out after {0:?}")]
    InitializeTimeout(Duration),
    #[error("MCP initialize failed: {0}")]
    Initialize(#[source] Box<rmcp::service::ClientInitializeError>),
    #[error("MCP initialize completed without server information")]
    MissingServerInfo,
    #[error("MCP {operation} timed out after {duration:?}")]
    RequestTimeout {
        operation: &'static str,
        duration: Duration,
    },
    #[error("MCP {operation} failed: {source}")]
    Request {
        operation: &'static str,
        #[source]
        source: rmcp::service::ServiceError,
    },
    #[error("MCP {operation} cancelled: {reason}")]
    Cancelled {
        operation: &'static str,
        reason: String,
    },
    #[error("MCP shutdown timed out after {0:?}")]
    ShutdownTimeout(Duration),
    #[error("MCP shutdown task failed: {0}")]
    Shutdown(#[source] tokio::task::JoinError),
    #[error("MCP Streamable HTTP endpoint must use http or https")]
    InvalidHttpEndpoint,
    #[error("MCP bearer token must be non-empty and contain no line breaks")]
    InvalidBearerToken,
}
