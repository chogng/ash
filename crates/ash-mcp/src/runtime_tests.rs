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
    resource_csp: Arc<Mutex<Option<serde_json::Value>>>,
    results: Arc<Mutex<std::collections::VecDeque<Result<CallToolResult, McpSessionError>>>>,
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
        let resource_csp = Arc::clone(&self.resource_csp);
        let results = Arc::clone(&self.results);
        Box::pin(async move {
            if should_fail {
                return Err(McpSessionError::Transport("connection refused".into()));
            }
            Ok(Box::new(FakeSession {
                server,
                calls,
                shutdowns,
                resource_csp,
                results,
            }) as Box<dyn McpSession>)
        })
    }
}

struct FakeSession {
    server: McpServerId,
    calls: Arc<Mutex<Vec<(McpServerId, String)>>>,
    shutdowns: Arc<Mutex<Vec<McpServerId>>>,
    resource_csp: Arc<Mutex<Option<serde_json::Value>>>,
    results: Arc<Mutex<std::collections::VecDeque<Result<CallToolResult, McpSessionError>>>>,
}

impl McpSession for FakeSession {
    fn server_info(&self) -> ServerInfo {
        serde_json::from_value(serde_json::json!({"protocolVersion":"2025-11-25","capabilities":{"resources":{}},"serverInfo":{"name":"test","version":"0"}})).unwrap()
    }

    fn list_tools(&self, cursor: McpPageCursor) -> McpSessionFuture<'_, ListToolsResult> {
        Box::pin(async move {
            if cursor != McpPageCursor::First {
                return Err(McpSessionError::Transport("unexpected cursor".into()));
            }
            let mut schema = JsonObject::new();
            schema.insert("type".into(), serde_json::Value::String("object".into()));
            let mut tool = Tool::new("docs.search", "Search documentation", Arc::new(schema));
            if self.server.as_str() == "user:mcp:apps" {
                tool.meta = Some(
                    serde_json::from_value(serde_json::json!({"ui":{"resourceUri":"ui://chart"}}))
                        .unwrap(),
                );
            }
            Ok(ListToolsResult {
                tools: vec![tool],
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
            if let Some(result) = self.results.lock().unwrap().pop_front() {
                return result;
            }
            Ok(CallToolResult::success(vec![ContentBlock::text(
                self.server.to_string(),
            )]))
        })
    }

    fn read_resource(
        &self,
        uri: String,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> McpSessionFuture<'_, ash_rmcp_client::ReadResourceResult> {
        let cancellation = cancellation.clone();
        Box::pin(async move {
            cancellation
                .check()
                .map_err(|signal| McpSessionError::Cancelled(signal.reason().to_string()))?;
            self.calls
                .lock()
                .unwrap()
                .push((self.server.clone(), format!("read:{uri}")));
            if uri.starts_with("ui://") {
                let csp = self.resource_csp.lock().unwrap().clone();
                return Ok(ash_rmcp_client::ReadResourceResult::new(vec![serde_json::from_value(serde_json::json!({
                    "uri":uri,"mimeType":"text/html;profile=mcp-app","text":"<p>App</p>","_meta":{"ui":{"csp":csp}}
                })).unwrap()]));
            }
            Ok(ash_rmcp_client::ReadResourceResult::new(vec![
                ash_rmcp_client::ResourceContents::TextResourceContents {
                    uri: if uri == "docs://wrong" {
                        "docs://other".into()
                    } else {
                        uri
                    },
                    mime_type: Some("text/plain".into()),
                    text: self.server.to_string(),
                    meta: None,
                },
            ]))
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

#[tokio::test]
async fn linked_resources_keep_the_frozen_server_and_reject_uri_substitution_stale_bindings_and_cancel()
 {
    let factory = Arc::new(FakeFactory::default());
    let runtime = McpRuntime::start_with_factory(
        vec![definition("user:mcp:one"), definition("user:mcp:two")],
        factory.clone(),
        McpRuntimeOptions::new("test", "0"),
    )
    .await
    .unwrap();
    let binding = runtime.catalog().tools()[0].binding().clone();
    let cancellation = CancellationSource::new();
    let data = runtime
        .read_resource(&binding, "docs://review".into(), &cancellation.token())
        .await
        .unwrap();
    assert!(
        matches!(data.data, ash_protocol::ToolOutputArtifactData::Text { text } if text == binding.remote().server().as_str())
    );
    assert_eq!(
        factory.calls.lock().unwrap().as_slice(),
        &[(
            binding.remote().server().clone(),
            "read:docs://review".into()
        )]
    );
    assert!(
        runtime
            .read_resource(&binding, "docs://wrong".into(), &cancellation.token())
            .await
            .is_err()
    );
    let replaced = McpRuntime::start_with_factory(
        vec![definition("user:mcp:one"), definition("user:mcp:two")],
        factory.clone(),
        McpRuntimeOptions::new("test", "0").with_catalog_generation(2),
    )
    .await
    .unwrap();
    let invalid = replaced.catalog().tools()[0].binding().clone();
    assert!(
        runtime
            .read_resource(&invalid, "docs://review".into(), &cancellation.token())
            .await
            .is_err()
    );
    replaced.shutdown().await;
    cancellation.cancel();
    assert!(
        runtime
            .read_resource(&binding, "docs://review".into(), &cancellation.token())
            .await
            .is_err()
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn declared_apps_retain_ui_metadata_without_replacing_the_text_tool_result() {
    let runtime = McpRuntime::start_with_factory(
        vec![definition("user:mcp:apps")],
        Arc::new(FakeFactory::default()),
        McpRuntimeOptions::new("test", "0").with_mcp_apps(),
    )
    .await
    .unwrap();
    let binding = runtime.catalog().tools()[0].binding();
    let output = runtime
        .call_tool(
            binding,
            serde_json::json!({"value":7}),
            &CancellationSource::new().token(),
        )
        .await
        .unwrap();
    let [ToolContent::Text(text), ToolContent::Artifact(app)] = output.content() else {
        panic!("expected text result and a declared App");
    };
    assert_eq!(text, "user:mcp:apps");
    assert_eq!(
        app.source,
        ash_protocol::ToolOutputArtifactSource::McpApp {
            uri: "ui://chart".into()
        }
    );
    assert_eq!(app.model_text(), "");
    let ash_protocol::ToolOutputArtifactData::Json { json } = &app.data else {
        panic!("expected View payload");
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(json).unwrap()["input"],
        serde_json::json!({"value": 7})
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn app_resource_csp_is_normalized_at_the_resource_boundary_and_rejects_policy_injection() {
    let factory = Arc::new(FakeFactory::default());
    let runtime = McpRuntime::start_with_factory(
        vec![definition("user:mcp:apps")],
        factory.clone(),
        McpRuntimeOptions::new("test", "0").with_mcp_apps(),
    )
    .await
    .unwrap();
    let binding = runtime.catalog().tools()[0].binding();
    *factory.resource_csp.lock().unwrap() = Some(
        serde_json::json!({"connectDomains":["https://API.example.com/","wss://events.example.com"],"resourceDomains":["https://*.cdn.example.com","https://*.cdn.example.com"],"frameDomains":["https://player.example.com"],"baseUriDomains":["https://cdn.example.com"]}),
    );
    let artifact = runtime
        .read_resource(
            binding,
            "ui://chart".into(),
            &CancellationSource::new().token(),
        )
        .await
        .unwrap();
    assert!(
        artifact
            .resource_metadata
            .as_ref()
            .unwrap()
            .contains("connectDomains")
    );
    let csp = artifact.app_csp.unwrap();
    assert_eq!(
        csp.connect_domains,
        ["https://api.example.com", "wss://events.example.com"]
    );
    assert_eq!(csp.resource_domains, ["https://*.cdn.example.com"]);
    for invalid in [
        serde_json::json!({"connectDomains":["https://safe.example; script-src *"]}),
        serde_json::json!({"connectDomains":["https://safe.example 'unsafe-eval'"]}),
        serde_json::json!({"connectDomains":["https://user:secret@safe.example"]}),
        serde_json::json!({"connectDomains":["https://safe.example/path"]}),
        serde_json::json!({"connectDomains":["https://safe.example?query=1"]}),
        serde_json::json!({"connectDomains":["https://safe.example#fragment"]}),
        serde_json::json!({"connectDomains":["https://*.*.example.com"]}),
        serde_json::json!({"resourceDomains":["wss://safe.example"]}),
        serde_json::json!({"resourceDomains":["file:///secret"]}),
        serde_json::json!({"resourceDomains":["*"]}),
        serde_json::json!({"connectDomains":[4]}),
        serde_json::json!({"connectDomains":vec!["https://safe.example"; 33]}),
        serde_json::json!({"connectDomains":["https://safe.example"],"unexpected":"a".repeat(16_384)}),
    ] {
        *factory.resource_csp.lock().unwrap() = Some(invalid.clone());
        assert!(
            runtime
                .read_resource(
                    binding,
                    "ui://chart".into(),
                    &CancellationSource::new().token()
                )
                .await
                .is_err(),
            "{invalid}"
        );
    }
    runtime.shutdown().await;
}

#[tokio::test]
async fn production_metrics_distinguish_tool_errors_transport_and_cancellation_without_content() {
    let diagnostics = diagnostics::Diagnostics::default();
    let factory = Arc::new(FakeFactory::default());
    let mut tool_error = CallToolResult::success(vec![ContentBlock::text("private tool output")]);
    tool_error.is_error = Some(true);
    factory.results.lock().unwrap().extend([
        Ok(CallToolResult::success(vec![ContentBlock::text(
            "private output",
        )])),
        Ok(tool_error),
        Err(McpSessionError::Transport(
            "private credential /path".into(),
        )),
    ]);
    let runtime = McpRuntime::start_with_factory(
        vec![definition("user:mcp:docs")],
        factory.clone(),
        McpRuntimeOptions::new("ash-test", "0")
            .with_metrics(diagnostics.metrics())
            .with_metric_connectors(std::collections::BTreeMap::from([(
                McpServerId::new("user:mcp:docs").unwrap(),
                "test-connector".into(),
            )])),
    )
    .await
    .unwrap();
    let binding = runtime.catalog().tools()[0].binding().clone();
    let cancellation = CancellationSource::new();
    for _ in 0..3 {
        let _ = runtime
            .call_tool(
                &binding,
                serde_json::json!({"private": "argument"}),
                &cancellation.token(),
            )
            .await;
    }
    cancellation.cancel();
    assert!(
        runtime
            .call_tool(&binding, serde_json::json!({}), &cancellation.token())
            .await
            .is_err()
    );
    let snapshot = diagnostics.metrics().snapshot();
    let count = snapshot
        .iter()
        .filter(|s| s.name == "ash.mcp.call")
        .map(|s| s.count)
        .sum::<u64>();
    assert_eq!(count, 4);
    for error in ["tool_result", "mcp_request", "cancellation"] {
        assert!(
            snapshot
                .iter()
                .any(|s| s.name == "ash.mcp.call.error" && s.tags["error_type"] == error)
        );
    }
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains("private"));
    assert!(json.contains("user_mcp_docs"));
    assert!(json.contains("test-connector"));
    assert_eq!(factory.calls.lock().unwrap().len(), 3);
}
