use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationToken;
use ash_core::RecordToolCallRequest;
use ash_core::RecordToolResultRequest;
use ash_core::StartTurnRequest;
use ash_core::ToolAuthorization;
use ash_core::ToolCallOutput;
use ash_core::ToolService;
use ash_protocol::CommandId;
use ash_protocol::ContentPart;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolOutputArtifact;
use ash_protocol::ToolOutputArtifactData;
use ash_protocol::ToolOutputArtifactSource;
use core_api::ActionPolicyService;
use core_api::CoreError;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct ResourceTool {
    retired: AtomicBool,
    reads: AtomicUsize,
}

impl ToolService for ResourceTool {
    fn definitions(&self) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: ToolName::new("documents").unwrap(),
            description: if self.retired.load(Ordering::Acquire) {
                "replacement"
            } else {
                "original"
            }
            .into(),
            parameters: json!({"type":"object"}),
            strict: false,
        }]
    }
    fn read_resource(
        &self,
        _call: &ToolCall,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutputArtifact, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        assert_eq!(uri, "docs://original/report.md");
        self.reads.fetch_add(1, Ordering::Relaxed);
        Ok(ToolOutputArtifact::new(
            ToolOutputArtifactSource::EmbeddedResource { uri: uri.into() },
            "text/markdown".into(),
            ToolOutputArtifactData::Text {
                text: "# Original\r\n中文\r\n".into(),
            },
        ))
    }
    fn prepare(&self, _: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        panic!("resource reading must not execute or approve another tool call")
    }
    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        panic!("resource reading must not execute another tool call")
    }
}
impl ActionPolicyService for ResourceTool {
    fn revision(&self) -> String {
        "resource-test".into()
    }
    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        panic!("resource reading must not submit an unrelated action")
    }
}

#[test]
fn linked_resource_rpc_uses_canonical_coordinates_frozen_bindings_and_connection_owned_bytes() {
    let tools = Arc::new(ResourceTool::default());
    let server = crate::tests::server().with_tool_service(tools.clone(), tools.clone());
    let mut owner = server.connection();
    let mut other = server.connection();
    crate::tests::initialize(&server, &mut owner);
    crate::tests::initialize(&server, &mut other);
    let session = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"resource-session","title":"Resources","executionTarget":null}}),
    );
    let session_id =
        SessionId::new(session["result"]["session"]["sessionId"].as_str().unwrap()).unwrap();
    let thread_id = ThreadId::new(
        session["result"]["session"]["threads"][0]["threadId"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let sequence = server.threads().read_thread(&thread_id).unwrap().sequence;
    let turn = server
        .threads()
        .start_turn(
            &thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("resources").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Exact(sequence),
                model: None,
                reasoning_effort: None,
                policy_revision: "resource-test".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![ash_protocol::UserInput::Text {
                    text: "Read documents".into(),
                }],
            },
        )
        .unwrap();
    let tool_call = ToolCall {
        id: ToolCallId::new("documents-call").unwrap(),
        name: ToolName::new("documents").unwrap(),
        arguments: json!({}),
    };
    let binding = server
        .turn_executor_snapshot()
        .bind_tool_call(&tool_call, ToolCallCaller::Direct)
        .unwrap();
    let recorded = server
        .threads()
        .record_tool_call(
            &thread_id,
            &turn.turn_id,
            RecordToolCallRequest {
                tool_call_id: Some(tool_call.id.clone()),
                name: tool_call.name,
                arguments_json: "{}".into(),
                binding: Some(binding),
            },
        )
        .unwrap();
    let result = server
        .threads()
        .record_tool_result(
            &thread_id,
            &turn.turn_id,
            RecordToolResultRequest {
                tool_call_id: recorded.tool_call_id,
                output: ToolCallOutput::SuccessContent(vec![ContentPart::Artifact {
                    artifact: ToolOutputArtifact::new(
                        ToolOutputArtifactSource::ResourceLink {
                            uri: "docs://original/report.md".into(),
                        },
                        "text/markdown".into(),
                        ToolOutputArtifactData::Json {
                            json: "{\"name\":\"report.md\"}".into(),
                        },
                    ),
                }]),
            },
        )
        .unwrap();
    let params = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id(),"contentIndex":0,"operationId":"resource-read"});
    let opened = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":3,"method":"tool/resource/open","params":params}),
    );
    assert_eq!(opened["result"]["mimeType"], "text/markdown", "{opened}");
    let resource = &opened["result"]["resourceId"];
    let read = json!({"jsonrpc":"2.0","id":4,"method":"resource/read","params":{"resourceId":resource,"offset":0,"maxBytes":262144}});
    assert_eq!(
        call(&server, &mut other, read.clone())["error"]["message"],
        "ResourceNotOwner"
    );
    use base64::Engine;
    let read = call(&server, &mut owner, read);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(read["result"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        "# Original\r\n中文\r\n".as_bytes()
    );
    for (field, value) in [
        ("itemId", json!("missing")),
        ("contentIndex", json!(3)),
        ("sessionId", json!("other")),
        ("uri", json!("file:///secret")),
    ] {
        let mut invalid = params.clone();
        invalid[field] = value;
        invalid["operationId"] = json!(format!("invalid-{field}"));
        assert!(
            call(
                &server,
                &mut owner,
                json!({"jsonrpc":"2.0","id":5,"method":"tool/resource/open","params":invalid})
            )
            .get("error")
            .is_some()
        );
    }
    tools.retired.store(true, Ordering::Release);
    let mut retired = params;
    retired["operationId"] = json!("retired-read");
    assert!(
        call(
            &server,
            &mut owner,
            json!({"jsonrpc":"2.0","id":6,"method":"tool/resource/open","params":retired})
        )
        .get("error")
        .is_some()
    );
    assert_eq!(tools.reads.load(Ordering::Relaxed), 1);
    let cancellation = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":7,"method":"tool/resource/cancel","params":{"sessionId":session_id,"threadId":thread_id,"operationId":"cancelled-read"}}),
    );
    assert!(cancellation.get("result").is_some(), "{cancellation}");
    tools.retired.store(false, Ordering::Release);
    retired["operationId"] = json!("cancelled-read");
    assert_eq!(
        call(
            &server,
            &mut owner,
            json!({"jsonrpc":"2.0","id":8,"method":"tool/resource/open","params":retired})
        )["error"]["message"],
        "RequestCancelled"
    );
    assert_eq!(tools.reads.load(Ordering::Relaxed), 1);
    let app_read = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id(),"contentIndex":0,"uri":"docs://original/report.md","operationId":"non-app"});
    assert!(
        call(
            &server,
            &mut owner,
            json!({"jsonrpc":"2.0","id":9,"method":"tool/app/resource/open","params":app_read})
        )
        .get("error")
        .is_some()
    );
    assert_eq!(tools.reads.load(Ordering::Relaxed), 1);
}

fn call(
    server: &super::AppServer,
    connection: &mut super::ConnectionState,
    request: Value,
) -> Value {
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}

#[derive(Default)]
struct AppTools {
    executions: AtomicUsize,
}

impl ToolService for AppTools {
    fn list_app_tools(
        &self,
        origin: &ToolCall,
        binding: &ash_protocol::ToolCallBinding,
    ) -> Result<Vec<Value>, CoreError> {
        self.validate_call_binding(origin, Some(binding))?;
        assert_eq!(origin.name.as_str(), "report");
        Ok(vec![
            json!({"name":"edit","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}}),
        ])
    }

    fn definitions(&self) -> Vec<ToolDefinition> {
        ["report", "edit"]
            .map(|name| ToolDefinition {
                name: ToolName::new(name).unwrap(),
                description: name.into(),
                parameters: json!({"type":"object"}),
                strict: false,
            })
            .into()
    }

    fn resolve_app_tool_call(
        &self,
        origin: &ToolCall,
        binding: &ash_protocol::ToolCallBinding,
        name: &str,
        arguments: Value,
        id: ToolCallId,
    ) -> Result<(ToolCall, ash_protocol::ToolCallBinding), CoreError> {
        self.validate_call_binding(origin, Some(binding))?;
        if origin.name.as_str() != "report" || name != "edit" {
            return Err(CoreError::Policy("App tool is unavailable".into()));
        }
        let call = ToolCall {
            id,
            name: ToolName::new(name).unwrap(),
            arguments,
        };
        let binding = self.bind_call(&call, ToolCallCaller::Direct)?.unwrap();
        Ok((call, binding))
    }

    fn read_resource(
        &self,
        call: &ToolCall,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutputArtifact, CoreError> {
        cancellation
            .check()
            .map_err(|_| CoreError::Cancelled("cancelled".into()))?;
        assert_eq!(call.name.as_str(), "report");
        if uri == "ui://report" {
            let mut resource = ToolOutputArtifact::new(
                ToolOutputArtifactSource::EmbeddedResource { uri: uri.into() },
                "text/html;profile=mcp-app".into(),
                ToolOutputArtifactData::Text {
                    text: "<p>App</p>".into(),
                },
            );
            resource.app_csp = Some(ash_protocol::McpAppResourceCsp {
                connect_domains: vec!["https://api.example.com".into()],
                ..Default::default()
            });
            return Ok(resource);
        }
        assert_eq!(uri, "docs://report/data");
        Ok(ToolOutputArtifact::new(
            ToolOutputArtifactSource::EmbeddedResource { uri: uri.into() },
            "application/json".into(),
            ToolOutputArtifactData::Text {
                text: "{\"value\":8}\r\n".into(),
            },
        ))
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Ok(ActionReviewRequest::new(
            ash_action_policy::ResolvedAction::new(
                ash_protocol::ActionDigest::from_canonical_bytes(
                    serde_json::to_vec(&call.arguments).unwrap(),
                ),
                ash_protocol::ActionKind::ExternalServiceMutation,
                "Edit the report",
                ash_protocol::CapabilitySet::new([ash_protocol::Capability::new(
                    ash_protocol::CapabilityKind::ExternalMutation,
                    "report",
                )]),
            ),
            ash_protocol::ActionProvenance::new(ash_protocol::ActionSource::McpServer, "test-app"),
            ash_action_policy::SandboxCompatibility::NotApplicable {
                reason: "remote action".into(),
            },
            ash_protocol::ActionPolicyRevision::new("app-test"),
        ))
    }

    fn execute(
        &self,
        call: &ToolCall,
        authority: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|_| CoreError::Cancelled("cancelled".into()))?;
        let ToolAuthorization::ApprovedOnce(grant) = authority else {
            panic!("App mutation requires a one-time Core approval");
        };
        assert_eq!(grant.tool_call_id(), &call.id);
        self.executions.fetch_add(1, Ordering::Relaxed);
        Ok(ToolExecutionOutput::SuccessContent(vec![
            ContentPart::Text(format!("Edited {}", call.arguments["value"])),
            ContentPart::Artifact {
                artifact: ToolOutputArtifact::new(
                    ToolOutputArtifactSource::ViewMetadata,
                    "application/json".into(),
                    ToolOutputArtifactData::Json {
                        json: "{\"viewOnly\":8}".into(),
                    },
                ),
            },
        ]))
    }
}

impl ActionPolicyService for AppTools {
    fn revision(&self) -> String {
        "app-test".into()
    }
    fn decide(
        &self,
        request: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Ok(ExecutionDecision::AskUser(
            ash_action_policy::ApprovalRequest::new(
                request.action().digest().clone(),
                request.action().required_capabilities().clone(),
                "Approve the report edit",
            ),
        ))
    }
}

struct NoAppModel;
impl core_api::ModelService for NoAppModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ash_protocol::ModelRequest,
        _: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        panic!("App Tool Turns must never invoke a model")
    }
}

#[test]
fn app_tool_rpc_uses_the_original_thread_approval_result_and_cancellation() {
    let tools = Arc::new(AppTools::default());
    let server = Arc::new(
        super::AppServer::new(
            Arc::new(ash_core::ThreadController::with_store(Arc::new(
                ash_core::InMemoryThreadStore::default(),
            ))),
            Arc::new(NoAppModel),
        )
        .with_ephemeral_env_state()
        .with_tool_service(tools.clone(), tools.clone()),
    );
    let mut owner = server.connection();
    let initialized = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"app-test","version":"1"},"capabilities":{"agentInteractions":{"version":1,"kinds":["approval"]}}}}),
    );
    assert!(initialized.get("result").is_some(), "{initialized}");
    let created = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":2,"method":"session/create","params":{"commandId":"app-session","title":"App","executionTarget":null}}),
    );
    let session = &created["result"]["session"];
    let session_id = SessionId::new(session["sessionId"].as_str().unwrap()).unwrap();
    let thread_id = ThreadId::new(session["threads"][0]["threadId"].as_str().unwrap()).unwrap();
    let turn = server
        .threads()
        .start_turn(
            &thread_id,
            StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: CommandId::new("app-origin").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                policy_revision: "app-test".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: Vec::new(),
                input: vec![ash_protocol::UserInput::Text {
                    text: "Report".into(),
                }],
            },
        )
        .unwrap();
    let origin = ToolCall {
        id: ToolCallId::new("report-origin").unwrap(),
        name: ToolName::new("report").unwrap(),
        arguments: json!({}),
    };
    let binding = server
        .turn_executor_snapshot()
        .bind_tool_call(&origin, ToolCallCaller::Direct)
        .unwrap();
    server
        .threads()
        .record_tool_call(
            &thread_id,
            &turn.turn_id,
            RecordToolCallRequest {
                tool_call_id: Some(origin.id.clone()),
                name: origin.name,
                arguments_json: "{}".into(),
                binding: Some(binding),
            },
        )
        .unwrap();
    let result = server
        .threads()
        .record_tool_result(
            &thread_id,
            &turn.turn_id,
            RecordToolResultRequest {
                tool_call_id: origin.id,
                output: ToolCallOutput::SuccessContent(vec![ContentPart::Artifact {
                    artifact: ToolOutputArtifact::new(
                        ToolOutputArtifactSource::McpApp {
                            uri: "ui://report".into(),
                        },
                        "text/html;profile=mcp-app".into(),
                        ToolOutputArtifactData::Json {
                            json: "{\"input\":{}}".into(),
                        },
                    ),
                }]),
            },
        )
        .unwrap();
    server
        .threads()
        .complete_turn_without_agent_message(&thread_id, &turn.turn_id)
        .unwrap();
    let app_list = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id(),"contentIndex":0});
    let listed = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":90,"method":"tool/app/list","params":app_list}),
    );
    assert_eq!(listed["result"]["tools"][0]["name"], "edit", "{listed}");
    assert_eq!(
        listed["result"]["tools"][0]["_meta"]["ui"]["visibility"],
        json!(["app"])
    );
    for (field, value) in [
        ("contentIndex", json!(1)),
        ("sessionId", json!("other")),
        ("serverId", json!("other")),
    ] {
        let mut invalid = app_list.clone();
        invalid[field] = value;
        assert!(
            call(
                &server,
                &mut owner,
                json!({"jsonrpc":"2.0","id":91,"method":"tool/app/list","params":invalid})
            )
            .get("error")
            .is_some()
        );
    }
    let resource_params = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id(),"contentIndex":0,"uri":"docs://report/data","operationId":"app-resource"});
    let template_params = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id(),"contentIndex":0,"operationId":"app-template"});
    let template = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":8,"method":"tool/resource/open","params":template_params}),
    );
    assert_eq!(
        template["result"]["appCsp"]["connectDomains"],
        json!(["https://api.example.com"]),
        "{template}"
    );
    let opened = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":5,"method":"tool/app/resource/open","params":resource_params}),
    );
    assert_eq!(opened["result"]["mimeType"], "application/json", "{opened}");
    assert_eq!(opened["result"]["encoding"], "text", "{opened}");
    let read = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":6,"method":"resource/read","params":{"resourceId":opened["result"]["resourceId"],"offset":0,"maxBytes":262144}}),
    );
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(read["result"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"{\"value\":8}\r\n"
    );
    assert_eq!(
        tools.executions.load(Ordering::Relaxed),
        0,
        "resource reads do not execute another tool"
    );
    for (field, value) in [
        ("contentIndex", json!(1)),
        ("uri", json!("bad\nuri")),
        ("serverId", json!("other-server")),
    ] {
        let mut invalid = resource_params.clone();
        invalid[field] = value;
        invalid["operationId"] = json!(format!("bad-resource-{field}"));
        assert!(
            call(
                &server,
                &mut owner,
                json!({"jsonrpc":"2.0","id":7,"method":"tool/app/resource/open","params":invalid})
            )
            .get("error")
            .is_some()
        );
    }
    let subscribed = call(
        &server,
        &mut owner,
        json!({"jsonrpc":"2.0","id":3,"method":"session/thread/subscribe","params":{"sessionId":session_id,"threadId":thread_id,"afterSequence":0}}),
    );
    assert!(subscribed.get("result").is_some(), "{subscribed}");
    let params = json!({"sessionId":session_id,"threadId":thread_id,"itemId":result.item.item_id(),"contentIndex":0,"remoteName":"edit","argumentsJson":"{\"value\":8}","operationId":"edit-approved"});
    for (field, value) in [
        ("contentIndex", json!(1)),
        ("remoteName", json!("model-only")),
        ("argumentsJson", json!("[]")),
        ("sessionId", json!("other")),
        ("uri", json!("file:///secret")),
    ] {
        let mut invalid = params.clone();
        invalid[field] = value;
        assert!(
            call(
                &server,
                &mut owner,
                json!({"jsonrpc":"2.0","id":4,"method":"tool/app/call","params":invalid})
            )
            .get("error")
            .is_some()
        );
    }
    for (index, decision) in ["approveOnce", "decline", "cancel"].into_iter().enumerate() {
        let mut params = params.clone();
        params["operationId"] = json!(format!("app-operation-{index}"));
        let request =
            json!({"jsonrpc":"2.0","id":10 + index,"method":"tool/app/call","params":params});
        let worker_server = server.clone();
        let mut worker_owner = owner.clone();
        let worker = std::thread::spawn(move || call(&worker_server, &mut worker_owner, request));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let snapshot = loop {
            let snapshot = server.threads().read_thread(&thread_id).unwrap();
            if snapshot
                .turns
                .last()
                .unwrap()
                .pending_interaction
                .as_ref()
                .is_some_and(|pending| {
                    server
                        .updates
                        .is_agent_interaction_owner(owner.connection_id, &pending.request_id)
                })
            {
                break snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "App Turn did not enter approval"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert_eq!(
            tools.executions.load(Ordering::Relaxed),
            usize::from(index > 0)
        );
        let app_turn = snapshot.turns.last().unwrap();
        assert_eq!(app_turn.model, None);
        let pending = app_turn.pending_interaction.as_ref().unwrap();
        if decision == "cancel" {
            let cancelled = call(
                &server,
                &mut owner,
                json!({"jsonrpc":"2.0","id":40,"method":"tool/app/cancel","params":{"sessionId":session_id,"threadId":thread_id,"operationId":params["operationId"]}}),
            );
            assert!(cancelled.get("result").is_some(), "{cancelled}");
        } else {
            let approved = call(
                &server,
                &mut owner,
                json!({"jsonrpc":"2.0","id":30 + index,"method":"session/request","params":{
                    "commandId":format!("app-approval-{index}"),"sessionId":session_id,"request":{"type":"resolveInteraction","threadId":thread_id,"expectedSequence":snapshot.sequence,"turnId":app_turn.turn_id,"requestId":pending.request_id,"response":{"type":"approval","response":{"decision":decision}}}
                }}),
            );
            assert!(approved.get("result").is_some(), "{approved}");
        }
        let response = worker.join().unwrap();
        if decision == "cancel" {
            assert_eq!(
                response["error"]["message"], "RequestCancelled",
                "{response}"
            );
        } else {
            assert_eq!(
                response["result"]["item"]["type"], "toolResult",
                "{response}"
            );
            assert_eq!(
                response["result"]["item"]["isError"],
                decision == "decline",
                "{response}"
            );
            let recorded = server.threads().read_thread(&thread_id).unwrap();
            assert!(
                recorded
                    .items
                    .iter()
                    .any(|item| serde_json::to_value(item).unwrap() == response["result"]["item"])
            );
        }
        assert_eq!(tools.executions.load(Ordering::Relaxed), 1);
        if index == 0 {
            let original = server.threads().read_thread(&thread_id).unwrap();
            let mut other = server.connection();
            let initialized = call(
                &server,
                &mut other,
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"another-app","version":"1"},"capabilities":{"agentInteractions":{"version":1,"kinds":["approval"]}}}}),
            );
            assert!(initialized.get("result").is_some());
            let worker_server = server.clone();
            let mut worker_owner = other.clone();
            let request = json!({"jsonrpc":"2.0","id":2,"method":"tool/app/call","params":params});
            let worker =
                std::thread::spawn(move || call(&worker_server, &mut worker_owner, request));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let separate = loop {
                let current = server.threads().read_thread(&thread_id).unwrap();
                if current.turns.len() > original.turns.len() || worker.is_finished() {
                    break current;
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            let cancelled = call(
                &server,
                &mut other,
                json!({"jsonrpc":"2.0","id":3,"method":"tool/app/cancel","params":{"sessionId":session_id,"threadId":thread_id,"operationId":params["operationId"]}}),
            );
            assert!(cancelled.get("result").is_some());
            let response = worker.join().unwrap();
            assert_eq!(
                separate.turns.len(),
                original.turns.len() + 1,
                "a different connection cannot replay the first connection's receipt: {response}"
            );
            assert_eq!(
                response["error"]["message"], "RequestCancelled",
                "{response}"
            );
            let after = server.threads().read_thread(&thread_id).unwrap();
            assert_eq!(
                after.turns[original.turns.len() - 1],
                original.turns[original.turns.len() - 1]
            );
        }
        let recorded = server.threads().read_thread(&thread_id).unwrap();
        let turn_id = &recorded.turns.last().unwrap().turn_id;
        assert!(!recorded.items.iter().any(|item| matches!(item, ash_protocol::ThreadItem::AgentMessage { turn_id: owner, .. } if owner == turn_id)));
    }
}
