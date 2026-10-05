use super::super::*;
use super::local_call;
use ash_async_utils::CancellationSource;
use ash_config::McpCredentialBinding;
use ash_config::McpServerConfig;
use ash_config::McpServerEnablement;
use ash_config::McpTransportConfig;
use ash_config::UserConfigCommand;
use ash_core::CreateThreadRequest;
use ash_core::StartTurnRequest;
use ash_protocol::AgentId;
use ash_protocol::CommandId;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::SessionId;
use ash_protocol::StopReason;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolMode;
use ash_protocol::ToolName;
use ash_protocol::TurnStatus;
use core_api::SequenceExpectation;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const WAIT: Duration = Duration::from_secs(10);

fn schema(name: &str, version: &str) -> Value {
    json!({
        "type": "object", "title": name,
        "properties": {"version": {"type": "string", "const": version}},
        "required": ["version"]
    })
}

fn catalog(stage: usize) -> Vec<(&'static str, &'static str)> {
    match stage {
        0 => vec![("removed", "v1"), ("status", "v1")],
        1 => vec![("added", "v2"), ("status", "v2")],
        2 => vec![("added", "v2")],
        _ => panic!("unexpected fixture stage {stage}"),
    }
}

enum ServerCommand {
    ChangeCatalog(usize, mpsc::Sender<()>),
    Stop,
}

/// The fixture speaks MCP over loopback HTTP, including the server's notification stream.
/// Catalog changes affect only the remote server; no Ash configuration or registry is changed
/// by the test, so a missing notification/reconcile step makes the next stage fail.
struct McpServer {
    url: String,
    commands: mpsc::Sender<ServerCommand>,
    streams: mpsc::Receiver<()>,
    worker: Option<thread::JoinHandle<()>>,
}

impl McpServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let (commands, receive) = mpsc::channel();
        let (ready, streams) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut stage = 0;
            let mut session = 0;
            let mut notifications = BTreeMap::<String, TcpStream>::new();
            loop {
                match receive.recv_timeout(Duration::from_millis(10)) {
                    Ok(ServerCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Ok(ServerCommand::ChangeCatalog(next, done)) => {
                        stage = next;
                        assert!(!notifications.is_empty(), "MCP has no notification stream");
                        for stream in notifications.values_mut() {
                            stream.write_all(b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n").unwrap();
                        }
                        done.send(()).unwrap();
                    }
                }
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(error) => panic!("accept MCP request: {error}"),
                };
                socket.set_read_timeout(Some(WAIT)).unwrap();
                socket.set_write_timeout(Some(WAIT)).unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let method = line.split_whitespace().next().unwrap().to_owned();
                let mut headers = BTreeMap::new();
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let (key, value) = line.trim().split_once(':').unwrap();
                    headers.insert(key.to_ascii_lowercase(), value.trim().to_owned());
                }
                match method.as_str() {
                    "GET" => {
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n").unwrap();
                        notifications.insert(headers["mcp-session-id"].clone(), socket);
                        ready.send(()).unwrap();
                    }
                    "DELETE" => {
                        notifications.remove(&headers["mcp-session-id"]);
                        reply(&mut socket, 200, "", "");
                    }
                    "POST" => {
                        let length = headers["content-length"].parse().unwrap();
                        let mut body = vec![0; length];
                        reader.read_exact(&mut body).unwrap();
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        let Some(id) = request.get("id") else {
                            assert_eq!(request["method"], "notifications/initialized");
                            reply(&mut socket, 202, "", "");
                            continue;
                        };
                        let mut session_header = String::new();
                        let result = match request["method"].as_str().unwrap() {
                            "initialize" => {
                                session += 1;
                                session_header = format!("Mcp-Session-Id: {session}\r\n");
                                json!({
                                    "protocolVersion": request["params"]["protocolVersion"],
                                    "capabilities": {"tools": {"listChanged": true}},
                                    "serverInfo": {"name": "catalog-fixture", "version": "1"}
                                })
                            }
                            "tools/list" => {
                                json!({"tools": catalog(stage).into_iter().map(|(name, version)| json!({
                                "name": name, "description": format!("Catalog {name} {version}"),
                                "inputSchema": schema(name, version)
                            })).collect::<Vec<_>>()})
                            }
                            "tools/call" => {
                                let name = request["params"]["name"].as_str().unwrap();
                                let (_, version) = catalog(stage)
                                    .into_iter()
                                    .find(|(current, _)| *current == name)
                                    .unwrap();
                                assert_eq!(request["params"]["arguments"]["version"], version);
                                json!({"content": [{"type": "text", "text": format!("{name}-{version}")}], "isError": false})
                            }
                            method => panic!("unexpected MCP method {method}"),
                        };
                        let response =
                            json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
                        reply(&mut socket, 200, &response, &session_header);
                    }
                    method => panic!("unexpected HTTP method {method}"),
                }
            }
        });
        Self {
            url,
            commands,
            streams,
            worker: Some(worker),
        }
    }

    fn wait_for_stream(&self) {
        self.streams
            .recv_timeout(WAIT)
            .expect("MCP notification stream connected");
    }

    fn change_catalog(&self, stage: usize) {
        let (done, completed) = mpsc::channel();
        self.commands
            .send(ServerCommand::ChangeCatalog(stage, done))
            .unwrap();
        completed.recv_timeout(WAIT).expect("MCP notification sent");
    }
}

fn reply(socket: &mut TcpStream, status: u16, body: &str, headers: &str) {
    write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).unwrap();
}

impl Drop for McpServer {
    fn drop(&mut self) {
        let _ = self.commands.send(ServerCommand::Stop);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.expect("MCP fixture worker completed");
        }
    }
}

#[derive(Default)]
struct CatalogModel(Mutex<Vec<ModelRequest>>);

impl ModelService for CatalogModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let mut requests = self.0.lock().unwrap();
        let index = requests.len();
        requests.push(request.clone());
        let (output, stop_reason) = if index % 2 == 0 {
            (
                vec![ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new(format!("catalog-cell-{index}")).unwrap(),
                    name: ToolName::new("exec").unwrap(),
                    arguments: json!({"source": r#"
                    const entries = ALL_TOOLS.filter(entry => entry.toolName.startsWith('mcp_user_mcp_catalog_'));
                    const results = [];
                    for (const entry of entries) {
                        const result = await tools[entry.name]({version: entry.inputSchema.properties.version.const});
                        results.push({name: entry.inputSchema.title, schema: entry.inputSchema, result: result.text, isError: result.isError});
                    }
                    results.sort((left, right) => left.name.localeCompare(right.name));
                    text(results);
                "#}),
                })],
                StopReason::ToolUse,
            )
        } else {
            (
                vec![ResponseItem::Text("done".into())],
                StopReason::Completed,
            )
        };
        Ok(ModelResponse {
            output,
            usage: None,
            billing: None,
            stop_reason,
        })
    }
}

#[test]
fn mcp_notifications_refresh_code_mode_catalog_without_changing_model_tools() {
    let fixture = McpServer::start();
    let profile = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigStore::open(profile.path().join("config.sqlite3")).unwrap());
    config
        .apply(ash_config::ConfigCommandRequest {
            command_id: CommandId::new("configure-mcp").unwrap(),
            expected_revision: config.read_snapshot().unwrap().revision,
            command: UserConfigCommand::UpsertMcpServer {
                server: McpServerConfig {
                    id: McpServerId::new("user:mcp:catalog").unwrap(),
                    display_name: "Catalog fixture".into(),
                    transport: McpTransportConfig::StreamableHttp {
                        url: fixture.url.clone(),
                    },
                    credential: McpCredentialBinding::Unauthenticated,
                    enablement: McpServerEnablement::Enabled,
                },
            },
        })
        .unwrap();
    let snapshot = config.read_snapshot().unwrap();
    let updates = McpCatalogUpdates::default();
    let changes = updates.subscribe();
    let initial = ash_mcp_extension::compose_mcp_tools_at_generation_with_updates(
        &snapshot.values,
        1,
        updates.clone(),
    )
    .unwrap()
    .unwrap();
    fixture.wait_for_stream();
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    let model = Arc::new(CatalogModel::default());
    let server = AppServer::new(threads.clone(), model.clone())
        .with_ephemeral_env_state()
        .with_config_store(config.clone())
        .with_env_config(&snapshot.values)
        .with_mcp_status_snapshot(initial.status)
        .with_local_env_host(
            Some(ToolPort::mcp(initial.tools, initial.policy)),
            crate::server::DirGrantPolicy::UserConfig(config.clone()),
        )
        .unwrap();
    let network_policy = OutboundNetworkPolicy::new(NetworkAccess::Any);
    let network = ash_http_client::OutboundNetworkSnapshot::with_policy(
        ash_http_client::HttpClientConfig::default(),
        network_policy.clone(),
    )
    .unwrap();
    let intents = crate::mcp_runtime::McpRuntimeIntents::default();
    let _watcher = ToolConfigWatcher::start(ToolConfigWatcherInputs {
        config: config.clone(),
        network,
        network_policy,
        dir_config: None,
        env_tools: server.local_env_tool_ports().unwrap(),
        env_runtime: server.env_runtime_control().unwrap(),
        connector_runtime: None,
        mcp_runtime_intent_changes: intents.subscribe(),
        mcp_runtime_intents: intents,
        mcp_changes: changes,
        mcp_updates: updates,
    });
    let mut connection = server.connection();
    let initialized = local_call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"catalog-test","version":"1"},"capabilities":{}}}),
    );
    assert!(initialized.get("result").is_some(), "{initialized}");
    let thread_id = ThreadId::new("catalog-thread").unwrap();
    threads
        .create_thread(CreateThreadRequest {
            execution_target: None,
            agent_id: AgentId::new("catalog-agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: SessionId::new("catalog-session").unwrap(),
            thread_id: thread_id.clone(),
            title: "MCP refresh".into(),
        })
        .unwrap();
    let mut request_id = 1;
    for stage in 0..3 {
        if stage != 0 {
            fixture.change_catalog(stage);
        }
        let deadline = Instant::now() + WAIT;
        loop {
            request_id += 1;
            let status = local_call(
                &server,
                &mut connection,
                json!({"jsonrpc":"2.0", "id":request_id, "method":"mcp/server/status", "params":{}}),
            );
            assert!(status.get("result").is_some(), "{status}");
            if status["result"]["catalogGeneration"].as_u64() == Some(stage as u64 + 2) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "MCP stage {stage} did not reconcile: {status}"
            );
            thread::sleep(Duration::from_millis(10));
        }
        fixture.wait_for_stream();
        // A notification must cause a new runtime catalog without any config mutation.
        assert_eq!(config.read_snapshot().unwrap().revision, snapshot.revision);
        let turn = threads
            .start_turn(
                &thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    command_id: CommandId::new(format!("catalog-turn-{stage}")).unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    policy_revision: server.test_action_policy_revision(),
                    approval_mode: ash_protocol::ApprovalMode::BypassPermissions,
                    tool_mode: ToolMode::CodeModeOnly,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![ash_protocol::UserInput::Text {
                        text: "discover and call current MCP tools".into(),
                    }],
                },
            )
            .unwrap();
        server
            .turn_executor_backend()
            .start(&thread_id, &turn.turn_id)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let cancellation = CancellationSource::new().token();
        let completed = loop {
            let changed = threads.thread_changed(&thread_id).unwrap();
            let snapshot = threads.read_thread(&thread_id).unwrap();
            assert_ne!(
                snapshot.turns[stage].status,
                TurnStatus::Failed,
                "{:?}",
                snapshot.items
            );
            if snapshot.turns[stage].status == TurnStatus::Completed {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "MCP turn {stage} timed out: {:?}",
                snapshot.items
            );
            pollster::block_on(ash_async_utils::wait_until(
                changed,
                deadline,
                &cancellation,
            ))
            .unwrap();
        };
        let call_id = ToolCallId::new(format!("catalog-cell-{}", stage * 2)).unwrap();
        let result = completed
            .items
            .iter()
            .find_map(|item| match item {
                ThreadItem::ToolResult {
                    tool_call_id,
                    text,
                    is_error: false,
                    ..
                } if tool_call_id == &call_id => Some(text),
                _ => None,
            })
            .unwrap_or_else(|| panic!("MCP stage {stage}: {:?}", completed.items));
        let expected = catalog(stage).into_iter().map(|(name, version)| json!({
            "name": name, "schema": schema(name, version), "result": format!("{name}-{version}"), "isError": false
        })).collect::<Vec<_>>();
        assert_eq!(
            serde_json::from_str::<Value>(result).unwrap(),
            json!(expected)
        );
    }
    let requests = model.0.lock().unwrap();
    assert_eq!(requests.len(), 6);
    assert_eq!(
        requests[0]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["exec", "wait"]
    );
    let initial_tools = serde_json::to_value(&requests[0].tools).unwrap();
    for request in requests.iter().skip(1) {
        assert_eq!(serde_json::to_value(&request.tools).unwrap(), initial_tools);
    }
}
