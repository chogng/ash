use ash_config::McpServerId;

/// Provider-neutral failure returned by an MCP session implementation.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum McpSessionError {
    #[error("{0}")]
    Transport(String),
    #[error("cancelled: {0}")]
    Cancelled(String),
}

/// Failures while constructing an immutable MCP runtime snapshot.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum McpRuntimeError {
    #[error("invalid MCP runtime options: {0}")]
    InvalidOptions(String),
    #[error("invalid MCP server definition '{server}': {message}")]
    InvalidDefinition {
        server: McpServerId,
        message: String,
    },
    #[error("duplicate MCP server id '{0}'")]
    DuplicateServer(McpServerId),
    #[error("MCP server '{server}' failed to start: {message}")]
    Startup {
        server: McpServerId,
        message: String,
    },
    #[error("MCP server '{server}' returned an invalid tool catalog: {message}")]
    Catalog {
        server: McpServerId,
        message: String,
    },
    #[error("MCP catalog alias collision for '{0}'")]
    AliasCollision(String),
    #[error("MCP tool binding is not part of this runtime snapshot")]
    StaleBinding,
    #[error("MCP server tool catalog is stale and must be rebuilt")]
    StaleCatalog,
    #[error("MCP tool arguments must be a JSON object")]
    InvalidArguments,
    #[error("MCP host definition cannot be projected to the model contract: {0}")]
    ModelProjection(String),
}

/// Failure semantics for one routed MCP tool invocation.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum McpCallError {
    #[error("MCP tool call did not start: {0}")]
    NotStarted(String),
    #[error("MCP tool call may have started but no trustworthy result is available: {0}")]
    OutcomeUncertain(String),
    #[error("MCP returned a result that cannot be projected safely: {0}")]
    InvalidResult(String),
}
