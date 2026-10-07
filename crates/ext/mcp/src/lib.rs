//! MCP configuration projection, live session ownership, and agent-tool policy integration.

mod auth;
mod composition;
mod connector;
mod elicitation;
mod plugin;
mod runtime;
mod status;
mod updates;

pub use auth::McpOAuthAuthorization;
pub use auth::McpOAuthChallenge;
pub use auth::McpOAuthCompleteRequest;
pub use auth::McpOAuthCredential;
pub use auth::McpOAuthCredentialReplacement;
pub use auth::McpOAuthError;
pub use auth::McpOAuthErrorKind;
pub use auth::McpOAuthExchangeRequest;
pub use auth::McpOAuthFlowId;
pub use auth::McpOAuthProvider;
pub use auth::McpOAuthRefreshRequest;
pub use auth::McpOAuthRevokeRequest;
pub use auth::McpOAuthService;
pub use auth::McpOAuthStartRequest;
pub use auth::McpOAuthTarget;
pub use composition::McpToolComposition;
pub use composition::McpToolCompositionError;
pub use composition::compose_mcp_tools;
pub use composition::compose_mcp_tools_at_generation_with_runtime_intents_and_updates;
pub use composition::compose_mcp_tools_at_generation_with_updates;
pub use composition::compose_mcp_tools_with_connectors;
pub use composition::compose_mcp_tools_with_connectors_and_runtime_intents_and_updates;
pub use composition::compose_mcp_tools_with_connectors_and_updates;
pub use composition::compose_mcp_tools_with_updates;
pub use connector::ConnectorMcpRuntimeError;
pub use connector::ConnectorMcpRuntimeProvider;
pub use connector::RuntimeInvocationFence;
pub use connector::RuntimeInvocationLease;
pub use connector::StandaloneMcpServer;
pub use plugin::PluginConnectorMcpRuntimeProvider;
pub use status::{
    McpRuntimeStatusSnapshot, McpServerRuntimeIntent, McpServerRuntimeState, McpServerRuntimeStatus,
};
pub use updates::McpCatalogUpdateSubscription;
pub use updates::McpCatalogUpdates;

mod marketplace;
pub use marketplace::MarketplaceConnectorCatalog;
pub use marketplace::combined_provider;
