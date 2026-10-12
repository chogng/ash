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
}

fn call(
    server: &super::AppServer,
    connection: &mut super::ConnectionState,
    request: Value,
) -> Value {
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}
