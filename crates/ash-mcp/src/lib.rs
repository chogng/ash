//! Product-level MCP connection, catalog, binding, and invocation runtime.

mod catalog;
mod definition;
mod error;
mod output;
mod runtime;
mod session;

pub use catalog::{
    McpCatalogFreshness, McpCatalogLimits, McpCatalogSnapshot, McpToolBinding, McpToolDescriptor,
    McpToolRef,
};
pub use definition::{McpServerDefinition, McpServerTransport};
pub use error::{McpCallError, McpRuntimeError, McpSessionError};
pub use runtime::{
    McpRuntime, McpRuntimeOptions, McpShutdownDiagnostic, McpStartupDiagnostic, McpStartupPolicy,
};
pub use session::{
    McpConnectFuture, McpPageCursor, McpSession, McpSessionFactory, McpSessionFuture,
    RmcpSessionFactory,
};
