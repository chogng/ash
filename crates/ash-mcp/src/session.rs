use std::future::Future;
use std::pin::Pin;

use ash_async_utils::CancellationToken;
use ash_rmcp_client::{
    CallToolRequestParams, CallToolResult, ListToolsResult, RmcpClient, RmcpClientOptions,
    ServerInfo,
};

use crate::{McpServerDefinition, McpServerTransport, McpSessionError};

/// Cursor state for one raw MCP list operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum McpPageCursor {
    First,
    After(String),
}

/// Future returned by an initialized MCP session operation.
pub type McpSessionFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, McpSessionError>> + Send + 'a>>;

/// Future returned while connecting one runtime-ready MCP server.
pub type McpConnectFuture =
    Pin<Box<dyn Future<Output = Result<Box<dyn McpSession>, McpSessionError>> + Send + 'static>>;

/// One initialized MCP session used by the product runtime.
///
/// Implementations preserve exact remote identities, keep request correlation within one
/// connection generation, propagate cancellation where the transport supports it, and never
/// perform catalog aliasing or Core durable writes.
pub trait McpSession: Send + Sync {
    fn server_info(&self) -> ServerInfo;

    fn list_tools(&self, cursor: McpPageCursor) -> McpSessionFuture<'_, ListToolsResult>;

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        cancellation: &CancellationToken,
    ) -> McpSessionFuture<'_, CallToolResult>;

    fn shutdown(self: Box<Self>) -> McpSessionFuture<'static, ()>;
}

/// Creates isolated MCP sessions from runtime-ready server definitions.
///
/// Implementations own transport placement only. They must not merge catalogs, resolve model
/// aliases, persist credentials, approve calls, or mutate Core state.
pub trait McpSessionFactory: Send + Sync {
    fn connect(
        &self,
        definition: McpServerDefinition,
        options: RmcpClientOptions,
    ) -> McpConnectFuture;
}

/// Production factory backed by `ash-rmcp-client`.
#[derive(Debug, Default)]
pub struct RmcpSessionFactory;

impl McpSessionFactory for RmcpSessionFactory {
    fn connect(
        &self,
        definition: McpServerDefinition,
        options: RmcpClientOptions,
    ) -> McpConnectFuture {
        Box::pin(async move {
            let (_, _, transport) = definition.into_parts();
            let client = match transport {
                McpServerTransport::Stdio(command) => {
                    RmcpClient::connect_stdio(command, options).await
                }
                McpServerTransport::StreamableHttp(server) => {
                    RmcpClient::connect_streamable_http(server, options).await
                }
            }
            .map_err(|error| McpSessionError::Transport(error.to_string()))?;
            Ok(Box::new(RmcpSession { client }) as Box<dyn McpSession>)
        })
    }
}

struct RmcpSession {
    client: RmcpClient,
}

impl McpSession for RmcpSession {
    fn server_info(&self) -> ServerInfo {
        self.client.server_info().clone()
    }

    fn list_tools(&self, cursor: McpPageCursor) -> McpSessionFuture<'_, ListToolsResult> {
        Box::pin(async move {
            match cursor {
                McpPageCursor::First => self.client.list_tools().await,
                McpPageCursor::After(cursor) => self.client.list_tools_after(cursor).await,
            }
            .map_err(|error| McpSessionError::Transport(error.to_string()))
        })
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        cancellation: &CancellationToken,
    ) -> McpSessionFuture<'_, CallToolResult> {
        let cancellation = cancellation.clone();
        Box::pin(async move {
            match self
                .client
                .call_tool_with_cancellation(request, async move {
                    cancellation.cancelled().await.reason().to_string()
                })
                .await
            {
                Ok(result) => Ok(result),
                Err(ash_rmcp_client::RmcpClientError::Cancelled { reason, .. }) => {
                    Err(McpSessionError::Cancelled(reason))
                }
                Err(error) => Err(McpSessionError::Transport(error.to_string())),
            }
        })
    }

    fn shutdown(self: Box<Self>) -> McpSessionFuture<'static, ()> {
        Box::pin(async move {
            self.client
                .shutdown()
                .await
                .map_err(|error| McpSessionError::Transport(error.to_string()))
        })
    }
}
