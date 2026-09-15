use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use tokio::sync::Notify;

use super::*;

struct TestServer;

impl ServerHandler for TestServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult {
            tools: vec![Tool::new("echo", "Echo input", Arc::new(JsonObject::new()))],
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        Ok(CallToolResult::success(vec![ContentBlock::text(request.name.into_owned())]).into())
    }
}

#[tokio::test]
async fn initializes_lists_and_calls_tools_over_an_in_process_transport() {
    let (server_transport, client_transport) = tokio::io::duplex(8 * 1024);
    let server = tokio::spawn(async move {
        TestServer
            .serve(server_transport)
            .await
            .expect("start test server")
            .waiting()
            .await
            .expect("join test server")
    });
    let options = RmcpClientOptions::new("ash-rmcp-client-test", "0").with_timeouts(RmcpTimeouts {
        initialize: Duration::from_secs(2),
        request: Duration::from_secs(2),
        shutdown: Duration::from_secs(2),
    });
    let client = RmcpClient::connect(client_transport, options)
        .await
        .expect("initialize client");

    assert!(client.server_info().capabilities.tools.is_some());
    let tools = client.list_tools().await.expect("list tools");
    assert_eq!(tools.tools.len(), 1);
    assert_eq!(tools.tools[0].name, "echo");

    let result = client
        .call_tool(CallToolRequestParams::new("echo"))
        .await
        .expect("call tool");
    assert_eq!(result.is_error, Some(false));
    assert_eq!(result.content.len(), 1);

    client.shutdown().await.expect("shutdown client");
    server.await.expect("server task");
}

#[test]
fn transport_configuration_rejects_header_injection_and_redacts_secrets() {
    assert!(StreamableHttpServer::new("file:///tmp/mcp").is_err());
    assert!(BearerToken::new("secret\nforged").is_err());

    let token = BearerToken::new("secret").expect("valid token");
    assert_eq!(format!("{token:?}"), "BearerToken([REDACTED])");
    let server = StreamableHttpServer::new("https://example.com/mcp")
        .expect("valid endpoint")
        .with_bearer_token(token);
    assert_eq!(server.uri(), "https://example.com/mcp");
}

struct CancellationServer {
    cancelled: Arc<Notify>,
}

impl ServerHandler for CancellationServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn call_tool(
        &self,
        _request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        context.ct.cancelled().await;
        self.cancelled.notify_one();
        Ok(CallToolResult::success(Vec::new()).into())
    }
}

#[tokio::test]
async fn request_timeout_sends_protocol_cancellation() {
    let (server_transport, client_transport) = tokio::io::duplex(8 * 1024);
    let cancelled = Arc::new(Notify::new());
    let server_cancelled = Arc::clone(&cancelled);
    let server = tokio::spawn(async move {
        CancellationServer {
            cancelled: server_cancelled,
        }
        .serve(server_transport)
        .await
        .expect("start cancellation server")
        .waiting()
        .await
        .expect("join cancellation server")
    });
    let client = RmcpClient::connect(
        client_transport,
        RmcpClientOptions::new("ash-rmcp-client-test", "0").with_timeouts(RmcpTimeouts {
            initialize: Duration::from_secs(2),
            request: Duration::from_millis(25),
            shutdown: Duration::from_secs(2),
        }),
    )
    .await
    .expect("initialize client");

    let error = client
        .call_tool(CallToolRequestParams::new("wait"))
        .await
        .expect_err("tool call should time out");
    assert!(matches!(
        error,
        RmcpClientError::RequestTimeout {
            operation: "tools/call",
            ..
        }
    ));
    tokio::time::timeout(Duration::from_secs(1), cancelled.notified())
        .await
        .expect("server should receive cancellation");

    client.shutdown().await.expect("shutdown client");
    server.await.expect("server task");
}

#[tokio::test]
async fn caller_cancellation_sends_protocol_cancellation() {
    let (server_transport, client_transport) = tokio::io::duplex(8 * 1024);
    let cancelled = Arc::new(Notify::new());
    let server_cancelled = Arc::clone(&cancelled);
    let server = tokio::spawn(async move {
        CancellationServer {
            cancelled: server_cancelled,
        }
        .serve(server_transport)
        .await
        .expect("start cancellation server")
        .waiting()
        .await
        .expect("join cancellation server")
    });
    let client = RmcpClient::connect(
        client_transport,
        RmcpClientOptions::new("ash-rmcp-client-test", "0").with_timeouts(RmcpTimeouts {
            initialize: Duration::from_secs(2),
            request: Duration::from_secs(2),
            shutdown: Duration::from_secs(2),
        }),
    )
    .await
    .expect("initialize client");

    let error = client
        .call_tool_with_cancellation(CallToolRequestParams::new("wait"), async {
            tokio::task::yield_now().await;
            "user interrupted".into()
        })
        .await
        .expect_err("tool call should be cancelled");
    assert!(matches!(
        error,
        RmcpClientError::Cancelled {
            operation: "tools/call",
            reason
        } if reason == "user interrupted"
    ));
    tokio::time::timeout(Duration::from_secs(1), cancelled.notified())
        .await
        .expect("server should receive cancellation");

    client.shutdown().await.expect("shutdown client");
    server.await.expect("server task");
}
