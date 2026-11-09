use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, JsonObject,
    ListToolsResult, PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
    Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use tokio::sync::Notify;

use super::*;

struct TestServer;

tokio::task_local! { static CALL_OWNER: String; }

struct ContextHost;
struct CapturedHost(String);

impl McpClientHost for ContextHost {
    fn capture_request_context(&self) -> Option<Arc<dyn McpClientHost>> {
        Some(Arc::new(CapturedHost(CALL_OWNER.with(Clone::clone))))
    }
}

impl McpClientHost for CapturedHost {
    fn handle_elicitation(
        &self,
        _: McpElicitation,
    ) -> HostFuture<Result<ElicitResult, rmcp::ErrorData>> {
        let owner = self.0.clone();
        Box::pin(async move {
            // The callback runs in RMCP's task, outside the initiating task-local scope.
            assert!(CALL_OWNER.try_with(|_| ()).is_err());
            Ok(ElicitResult::new(ElicitationAction::Accept)
                .with_content(serde_json::json!({"owner": owner})))
        })
    }
}

struct ElicitationServer;

#[derive(Clone)]
struct GatedHost {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

impl McpClientHost for GatedHost {
    fn capture_request_context(&self) -> Option<Arc<dyn McpClientHost>> {
        Some(Arc::new(self.clone()))
    }

    fn handle_elicitation(
        &self,
        _: McpElicitation,
    ) -> HostFuture<Result<ElicitResult, rmcp::ErrorData>> {
        let host = self.clone();
        Box::pin(async move {
            host.started.notify_one();
            host.release.notified().await;
            Ok(ElicitResult::new(ElicitationAction::Accept))
        })
    }
}

impl ServerHandler for ElicitationServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn call_tool(
        &self,
        _: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let request: ElicitRequestParams = serde_json::from_value(serde_json::json!({
            "mode": "form", "message": "Question", "requestedSchema": {"type": "object", "properties": {"owner": {"type": "string"}}}
        })).unwrap();
        let answer = context
            .peer
            .send_request(rmcp::model::ServerRequest::ElicitRequest(
                rmcp::model::ElicitRequest::new(request),
            ))
            .await
            .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string(&answer).unwrap(),
        )])
        .into())
    }
}

#[tokio::test]
async fn real_elicitation_dispatch_retains_each_concurrent_call_context() {
    let (server_transport, client_transport) = tokio::io::duplex(8 * 1024);
    let server = tokio::spawn(async move {
        ElicitationServer
            .serve(server_transport)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    });
    let client = RmcpClient::connect(
        client_transport,
        RmcpClientOptions::new("elicitation-test", "0")
            .with_host(Arc::new(ContextHost))
            .with_form_elicitation(),
    )
    .await
    .unwrap();
    let (first, second) = tokio::join!(
        CALL_OWNER.scope(
            "first".into(),
            client.call_tool(CallToolRequestParams::new("first"))
        ),
        CALL_OWNER.scope(
            "second".into(),
            client.call_tool(CallToolRequestParams::new("second"))
        ),
    );
    for (result, owner) in [(first, "first"), (second, "second")] {
        let wire = serde_json::to_value(result.unwrap()).unwrap();
        let answer: serde_json::Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            answer,
            serde_json::json!({"action": "accept", "content": {"owner": owner}})
        );
    }
    client.shutdown().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn cancelling_a_call_waiting_for_elicitation_does_not_wait_for_the_active_answer() {
    let (server_transport, client_transport) = tokio::io::duplex(8 * 1024);
    let server = tokio::spawn(async move {
        ElicitationServer
            .serve(server_transport)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    });
    let host = GatedHost {
        started: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
    };
    let client = Arc::new(
        RmcpClient::connect(
            client_transport,
            RmcpClientOptions::new("elicitation-test", "0")
                .with_host(Arc::new(host.clone()))
                .with_form_elicitation(),
        )
        .await
        .unwrap(),
    );
    let active_client = Arc::clone(&client);
    let active = tokio::spawn(async move {
        active_client
            .call_tool(CallToolRequestParams::new("active"))
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), host.started.notified())
        .await
        .unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(2),
        client.call_tool_with_cancellation(CallToolRequestParams::new("cancelled"), async {
            "stopped before dispatch".into()
        }),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(matches!(
        error,
        RmcpClientError::Cancelled {
            operation: "tools/call",
            ..
        }
    ));
    host.release.notify_one();
    active.await.unwrap().unwrap();
    Arc::try_unwrap(client)
        .ok()
        .unwrap()
        .shutdown()
        .await
        .unwrap();
    server.await.unwrap();
}

impl ServerHandler for TestServer {
    fn get_info(&self) -> ServerConfig {
        let mut config = ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
        .with_server_info(Implementation::new("test-server", "1"))
        .with_instructions("Use echo to repeat input.");
        config.meta = Some(rmcp::model::MetaObject(JsonObject::from_iter([(
            "ash/test".into(),
            serde_json::json!(true),
        )])));
        config
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

    async fn read_resource(
        &self,
        request: rmcp::model::ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ReadResourceResponse, rmcp::ErrorData> {
        assert_eq!(
            context
                .peer
                .peer_info()
                .unwrap()
                .capabilities
                .extensions
                .as_ref()
                .unwrap()["io.modelcontextprotocol/ui"]["mimeTypes"],
            serde_json::json!(["text/html;profile=mcp-app"])
        );
        Ok(rmcp::model::ReadResourceResult::new(vec![
            rmcp::model::ResourceContents::TextResourceContents {
                uri: request.uri,
                mime_type: Some("text/markdown".into()),
                text: "# Review\r\n中文\r\n".into(),
                meta: None,
            },
        ])
        .into())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        assert_eq!(
            context
                .peer
                .peer_info()
                .unwrap()
                .capabilities
                .extensions
                .as_ref()
                .unwrap()["ash/resultReview"]["versions"],
            serde_json::json!([1])
        );
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
    let options = RmcpClientOptions::new("ash-rmcp-client-test", "0")
        .with_result_review()
        .with_mcp_apps()
        .with_timeouts(RmcpTimeouts {
            initialize: Duration::from_secs(2),
            request: Duration::from_secs(2),
            shutdown: Duration::from_secs(2),
        });
    let client = RmcpClient::connect(client_transport, options)
        .await
        .expect("initialize client");

    assert_eq!(client.server_info(), &TestServer.get_info());
    let tools = client.list_tools().await.expect("list tools");
    assert_eq!(tools.tools.len(), 1);
    assert_eq!(tools.tools[0].name, "echo");

    let result = client
        .call_tool(CallToolRequestParams::new("echo"))
        .await
        .expect("call tool");
    assert_eq!(result.is_error, Some(false));
    assert_eq!(result.content.len(), 1);

    let resource = client
        .read_resource_with_cancellation("docs://review.md".into(), std::future::pending())
        .await
        .unwrap();
    assert_eq!(resource.contents.len(), 1);
    assert!(
        matches!(&resource.contents[0], rmcp::model::ResourceContents::TextResourceContents { uri, text, .. } if uri == "docs://review.md" && text == "# Review\r\n中文\r\n")
    );

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
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
    }

    async fn read_resource(
        &self,
        _: rmcp::model::ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ReadResourceResponse, rmcp::ErrorData> {
        context.ct.cancelled().await;
        self.cancelled.notify_one();
        Ok(rmcp::model::ReadResourceResult::new(Vec::new()).into())
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

#[tokio::test]
async fn streamable_http_does_not_follow_redirects_or_replay_bearer_tokens() {
    use std::net::TcpListener;
    use tokio::io::AsyncBufReadExt;
    use tokio::io::AsyncWriteExt;
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let location = destination.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut reader = tokio::io::BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{location}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        reader
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
        headers
    });
    let server_config = StreamableHttpServer::new(endpoint)
        .unwrap()
        .with_bearer_token(BearerToken::new("private-token").unwrap());
    let result = RmcpClient::connect_streamable_http(
        server_config,
        RmcpClientOptions::new("http-test", "0").with_timeouts(RmcpTimeouts {
            initialize: Duration::from_secs(2),
            request: Duration::from_secs(2),
            shutdown: Duration::from_secs(2),
        }),
    )
    .await;
    let error = result.err().expect("redirect must reject initialization");
    assert!(matches!(error, RmcpClientError::Initialize(_)), "{error}");
    let headers = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer private-token")
    );
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn cancelling_a_resource_read_reaches_the_peer_request() {
    let (server_transport, client_transport) = tokio::io::duplex(8 * 1024);
    let cancelled = Arc::new(Notify::new());
    let server_cancelled = cancelled.clone();
    let server = tokio::spawn(async move {
        CancellationServer {
            cancelled: server_cancelled,
        }
        .serve(server_transport)
        .await
        .unwrap()
        .waiting()
        .await
        .unwrap()
    });
    let client = RmcpClient::connect(
        client_transport,
        RmcpClientOptions::new("resource-test", "0"),
    )
    .await
    .unwrap();
    let error = client
        .read_resource_with_cancellation("docs://waiting".into(), async {
            tokio::task::yield_now().await;
            "resource removed".into()
        })
        .await
        .unwrap_err();
    assert!(
        matches!(error, RmcpClientError::Cancelled { operation: "resources/read", reason } if reason == "resource removed")
    );
    tokio::time::timeout(Duration::from_secs(1), cancelled.notified())
        .await
        .unwrap();
    client.shutdown().await.unwrap();
    server.await.unwrap();
}
