use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use ash_async_utils::CancellationSource;
use ash_config::McpServerId;
use ash_rmcp_client::{
    CallToolRequestParams, CallToolResult, ContentBlock, JsonObject, ListToolsResult,
    RmcpClientOptions, ServerInfo, Tool,
};
use ash_tools::{ToolContent, ToolOutputStatus};

use super::*;
use crate::{
    McpConnectFuture, McpPageCursor, McpServerTransport, McpSessionError, McpSessionFuture,
};

#[derive(Default)]
struct FakeFactory {
    failing: BTreeSet<McpServerId>,
    calls: Arc<Mutex<Vec<(McpServerId, String)>>>,
    shutdowns: Arc<Mutex<Vec<McpServerId>>>,
}

impl McpSessionFactory for FakeFactory {
    fn connect(
        &self,
        definition: McpServerDefinition,
        _options: RmcpClientOptions,
    ) -> McpConnectFuture {
        let server = definition.id().clone();
        let should_fail = self.failing.contains(&server);
        let calls = Arc::clone(&self.calls);
        let shutdowns = Arc::clone(&self.shutdowns);
        Box::pin(async move {
            if should_fail {
                return Err(McpSessionError::Transport("connection refused".into()));
            }
            Ok(Box::new(FakeSession {
                server,
                calls,
                shutdowns,
            }) as Box<dyn McpSession>)
        })
    }
}

struct FakeSession {
    server: McpServerId,
    calls: Arc<Mutex<Vec<(McpServerId, String)>>>,
    shutdowns: Arc<Mutex<Vec<McpServerId>>>,
}

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
                tools: vec![Tool::new(
                    "docs.search",
                    "Search documentation",
                    Arc::new(schema),
                )],
                ..Default::default()
            })
        })
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _cancellation: &ash_async_utils::CancellationToken,
    ) -> McpSessionFuture<'_, CallToolResult> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("call log lock")
                .push((self.server.clone(), request.name.to_string()));
            Ok(CallToolResult::success(vec![ContentBlock::text(
                self.server.to_string(),
            )]))
        })
    }

    fn shutdown(self: Box<Self>) -> McpSessionFuture<'static, ()> {
        Box::pin(async move {
            self.shutdowns
                .lock()
                .expect("shutdown log lock")
                .push(self.server);
            Ok(())
        })
    }
}

#[tokio::test]
async fn builds_cross_server_catalog_and_routes_by_frozen_binding() {
    let factory = Arc::new(FakeFactory::default());
    let runtime = McpRuntime::start_with_factory(
        vec![definition("user:mcp:docs"), definition("user:mcp:code")],
        factory.clone(),
        McpRuntimeOptions::new("ash-test", "0"),
    )
    .await
    .expect("start runtime");

    assert_eq!(runtime.connected_server_ids().count(), 2);
    assert_eq!(runtime.catalog().tools().len(), 2);
    assert_eq!(runtime.catalog().model_definitions().unwrap().len(), 2);
    let first = runtime.catalog().tools()[0].binding().clone();
    let second = runtime.catalog().tools()[1].binding().clone();
    assert_ne!(first.exposed_name(), second.exposed_name());
    assert_eq!(first.remote().remote_name(), "docs.search");

    let output = runtime
        .call_tool(
            &first,
            serde_json::json!({"query": "mcp"}),
            &CancellationSource::new().token(),
        )
        .await
        .expect("call routed tool");
    assert_eq!(output.status(), ToolOutputStatus::Success);
    assert!(matches!(output.content(), [ToolContent::Text(_)]));
    assert_eq!(
        factory.calls.lock().expect("call log").as_slice(),
        &[(first.remote().server().clone(), "docs.search".into())]
    );

    assert!(runtime.shutdown().await.is_empty());
    assert_eq!(factory.shutdowns.lock().expect("shutdown log").len(), 2);
}

#[tokio::test]
async fn partial_startup_retains_diagnostic_and_healthy_server() {
    let failed = McpServerId::new("user:mcp:failed").unwrap();
    let factory = Arc::new(FakeFactory {
        failing: BTreeSet::from([failed.clone()]),
        ..FakeFactory::default()
    });
    let runtime = McpRuntime::start_with_factory(
        vec![definition("user:mcp:docs"), definition(failed.as_str())],
        factory,
        McpRuntimeOptions::new("ash-test", "0").with_startup_policy(McpStartupPolicy::AllowPartial),
    )
    .await
    .expect("partial startup");

    assert_eq!(runtime.connected_server_ids().count(), 1);
    assert_eq!(runtime.diagnostics().len(), 1);
    assert_eq!(runtime.diagnostics()[0].server, failed);
    assert!(runtime.shutdown().await.is_empty());
}

#[tokio::test]
async fn rejects_binding_from_another_catalog_generation() {
    let first = McpRuntime::start_with_factory(
        vec![definition("user:mcp:docs")],
        Arc::new(FakeFactory::default()),
        McpRuntimeOptions::new("ash-test", "0")
            .with_catalog_generation(1)
            .with_first_connection_generation(1),
    )
    .await
    .unwrap();
    let old_binding = first.catalog().tools()[0].binding().clone();

    let second = McpRuntime::start_with_factory(
        vec![definition("user:mcp:docs")],
        Arc::new(FakeFactory::default()),
        McpRuntimeOptions::new("ash-test", "0")
            .with_catalog_generation(2)
            .with_first_connection_generation(2),
    )
    .await
    .unwrap();
    let error = second
        .call_tool(
            &old_binding,
            serde_json::json!({}),
            &CancellationSource::new().token(),
        )
        .await
        .expect_err("old binding must not be re-resolved by name");
    assert!(matches!(error, McpCallError::NotStarted(_)));

    assert!(first.shutdown().await.is_empty());
    assert!(second.shutdown().await.is_empty());
}

#[tokio::test]
async fn rejects_calls_after_server_catalog_becomes_stale() {
    let server = McpServerId::new("user:mcp:docs").unwrap();
    let runtime = McpRuntime::start_with_factory(
        vec![definition(server.as_str())],
        Arc::new(FakeFactory::default()),
        McpRuntimeOptions::new("ash-test", "0"),
    )
    .await
    .unwrap();
    let binding = runtime.catalog().tools()[0].binding().clone();
    runtime
        .connections
        .get(&server)
        .expect("connection")
        .catalog_stale
        .store(true, Ordering::Release);

    let error = runtime
        .call_tool(
            &binding,
            serde_json::json!({}),
            &CancellationSource::new().token(),
        )
        .await
        .expect_err("stale catalog must fail closed");

    assert!(matches!(error, McpCallError::NotStarted(_)));
    assert!(runtime.shutdown().await.is_empty());
}

#[tokio::test]
async fn rejects_zero_catalog_limit_before_connecting() {
    let factory = Arc::new(FakeFactory::default());
    let limits = McpCatalogLimits {
        maximum_pages_per_server: 0,
        ..McpCatalogLimits::default()
    };
    let error = match McpRuntime::start_with_factory(
        vec![definition("user:mcp:docs")],
        factory.clone(),
        McpRuntimeOptions::new("ash-test", "0").with_catalog_limits(limits),
    )
    .await
    {
        Ok(_) => panic!("zero page limit must be rejected"),
        Err(error) => error,
    };

    assert!(matches!(error, McpRuntimeError::InvalidOptions(_)));
    assert!(factory.shutdowns.lock().expect("shutdown log").is_empty());
}

#[test]
fn tool_list_changed_marks_catalog_stale_and_forwards_event() {
    #[derive(Default)]
    struct RecordingHost {
        events: Mutex<Vec<McpClientEvent>>,
    }

    impl McpClientHost for RecordingHost {
        fn on_event(&self, event: McpClientEvent) {
            self.events.lock().expect("event log").push(event);
        }
    }

    let stale = Arc::new(AtomicBool::new(false));
    let downstream = Arc::new(RecordingHost::default());
    let host = RuntimeClientHost {
        downstream: downstream.clone(),
        catalog_stale: stale.clone(),
    };

    host.on_event(McpClientEvent::ToolListChanged);

    assert!(stale.load(Ordering::Acquire));
    assert_eq!(downstream.events.lock().expect("event log").len(), 1);
}

fn definition(id: &str) -> McpServerDefinition {
    McpServerDefinition::new(
        McpServerId::new(id).expect("valid server id"),
        id,
        McpServerTransport::Stdio(ash_rmcp_client::StdioServerCommand::new("unused")),
    )
    .expect("valid definition")
}
