use std::sync::Arc;

use ash_async_utils::CancellationSource;
use ash_config::McpServerId;
use ash_mcp::{
    McpConnectFuture, McpPageCursor, McpRuntimeOptions, McpServerDefinition, McpServerTransport,
    McpSession, McpSessionError, McpSessionFactory, McpSessionFuture,
};
use ash_rmcp_client::{
    CallToolRequestParams, CallToolResult, ContentBlock, JsonObject, ListToolsResult,
    RmcpClientOptions, ServerInfo, StdioServerCommand, StreamableHttpServer, Tool,
};
use ash_tools::{ToolContent, ToolOutputStatus};

use super::McpRuntimeOwner;

struct FakeFactory;

impl McpSessionFactory for FakeFactory {
    fn connect(&self, definition: McpServerDefinition, _: RmcpClientOptions) -> McpConnectFuture {
        let server = definition.id().clone();
        Box::pin(async move { Ok(Box::new(FakeSession(server)) as Box<dyn McpSession>) })
    }
}

struct FakeSession(McpServerId);

impl McpSession for FakeSession {
    fn server_info(&self) -> ServerInfo {
        ServerInfo::default()
    }

    fn list_tools(&self, cursor: McpPageCursor) -> McpSessionFuture<'_, ListToolsResult> {
        Box::pin(async move {
            if cursor != McpPageCursor::First {
                return Err(McpSessionError::Transport("unexpected cursor".into()));
            }
            let mut schema = JsonObject::new();
            schema.insert("type".into(), serde_json::Value::String("object".into()));
            Ok(ListToolsResult {
                tools: vec![Tool::new("echo", "Echo server identity", Arc::new(schema))],
                ..Default::default()
            })
        })
    }

    fn call_tool(
        &self,
        _: CallToolRequestParams,
        _: &ash_async_utils::CancellationToken,
    ) -> McpSessionFuture<'_, CallToolResult> {
        Box::pin(async move {
            Ok(CallToolResult::success(vec![ContentBlock::text(
                self.0.to_string(),
            )]))
        })
    }

    fn shutdown(self: Box<Self>) -> McpSessionFuture<'static, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[test]
fn bridges_sync_calls_to_continuously_running_async_runtime() {
    let server = McpServerId::new("user:mcp:test").unwrap();
    let definition = McpServerDefinition::new(
        server.clone(),
        "Test",
        McpServerTransport::Stdio(StdioServerCommand::new("unused")),
    )
    .unwrap();
    let owner = McpRuntimeOwner::start_with_factory(
        vec![definition],
        McpRuntimeOptions::new("app-server-test", "0"),
        Arc::new(FakeFactory),
    )
    .expect("start owner");

    assert_eq!(owner.definitions().len(), 1);
    assert_eq!(owner.status().catalog_generation, 1);
    assert_eq!(owner.status().servers[0].server_id, server.to_string());
    assert_eq!(owner.status().servers[0].tool_count, 1);
    assert_eq!(owner.status().servers[0].http_origin, None);
    let tool_name = owner.definitions()[0].name.clone();
    let prepared = owner
        .prepare_call(&tool_name, serde_json::json!({}))
        .expect("prepare call");
    assert_eq!(prepared.binding().exposed_name(), &tool_name);
    let output = owner
        .call(prepared, CancellationSource::new().token(), None)
        .expect("call tool");

    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert_eq!(output.content(), &[ToolContent::Text(server.to_string())]);
}

#[test]
fn runtime_status_keeps_only_the_http_origin() {
    let definition = McpServerDefinition::new(
        McpServerId::new("plugin:acme/search:mcp:remote").unwrap(),
        "Search",
        McpServerTransport::StreamableHttp(
            StreamableHttpServer::new(
                "https://alice:secret@plugin.example.test:8443/rpc?token=private",
            )
            .unwrap(),
        ),
    )
    .unwrap();
    let owner = McpRuntimeOwner::start_with_factory(
        vec![definition],
        McpRuntimeOptions::new("app-server-test", "0"),
        Arc::new(FakeFactory),
    )
    .expect("start owner");

    assert_eq!(
        owner.status().servers[0].http_origin.as_deref(),
        Some("https://plugin.example.test:8443")
    );
    assert!(!format!("{:?}", owner.status()).contains("secret"));
    assert!(!format!("{:?}", owner.status()).contains("private"));
}

#[test]
fn prepared_call_rejects_non_object_arguments_before_dispatch() {
    let server = McpServerId::new("user:mcp:test").unwrap();
    let definition = McpServerDefinition::new(
        server,
        "Test",
        McpServerTransport::Stdio(StdioServerCommand::new("unused")),
    )
    .unwrap();
    let owner = McpRuntimeOwner::start_with_factory(
        vec![definition],
        McpRuntimeOptions::new("app-server-test", "0"),
        Arc::new(FakeFactory),
    )
    .expect("start owner");

    let error = owner
        .prepare_call(
            &owner.definitions()[0].name,
            serde_json::json!("not-an-object"),
        )
        .unwrap_err();
    assert!(error.to_string().contains("JSON object"));
}
