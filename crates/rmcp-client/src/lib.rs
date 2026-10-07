//! Low-level MCP client sessions built on the official RMCP SDK.

mod client;
mod error;
mod handler;
mod transport;

pub use client::{RmcpClient, RmcpClientOptions, RmcpTimeouts};
pub use error::RmcpClientError;
pub use handler::{HostFuture, McpClientEvent, McpClientHost, McpElicitation, NoopMcpClientHost};
pub use rmcp::ErrorData as RmcpErrorData;
pub use rmcp::model::RequestId as McpRequestId;
pub use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientInfo, ContentBlock, ElicitRequestParams,
    ElicitResult, ElicitationAction, Implementation, JsonObject, ListToolsResult,
    PaginatedRequestParams, ProgressNotificationParam, ServerInfo, Tool,
};
pub use transport::{BearerToken, HttpAuthorization, StdioServerCommand, StreamableHttpServer};

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
