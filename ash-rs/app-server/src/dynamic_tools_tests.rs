use super::compose_dynamic_tools;
use ash_action_policy::ExecutionDecision;
use ash_async_utils::CancellationSource;
use ash_protocol::AgentRequest;
use ash_protocol::AgentResponse;
use ash_protocol::DynamicToolOutput;
use ash_protocol::DynamicToolResponse;
use ash_protocol::DynamicToolSpec;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use serde_json::json;

fn specification(description: &str) -> DynamicToolSpec {
    DynamicToolSpec {
        name: ToolName::new("client_lookup").unwrap(),
        description: description.into(),
        input_schema: json!({
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"]
        }),
    }
}

fn call() -> ToolCall {
    ToolCall {
        id: ToolCallId::new("call-1").unwrap(),
        name: ToolName::new("client_lookup").unwrap(),
        arguments: json!({"query": "ash"}),
    }
}

#[test]
fn dynamic_tool_requires_approval_then_round_trips_the_frozen_call() {
    let composition = compose_dynamic_tools(vec![specification("Look up client state.")])
        .unwrap()
        .unwrap();
    let call = call();
    let reviewed = composition.tools.prepare(&call).unwrap();
    assert!(matches!(
        composition
            .policy
            .decide(&reviewed, &CancellationSource::new().token()),
        Ok(ExecutionDecision::AskUser(_))
    ));

    let request = composition
        .tools
        .execution_interaction(&call)
        .unwrap()
        .unwrap();
    let AgentRequest::DynamicTool { call: dynamic_call } = &request else {
        panic!("dynamic tool must produce a dynamic interaction")
    };
    assert_eq!(dynamic_call.call_id, call.id);
    assert_eq!(dynamic_call.name, call.name);
    assert_eq!(dynamic_call.arguments, call.arguments);
    assert_eq!(dynamic_call.definition_digest.len(), 64);

    let response = AgentResponse::DynamicTool {
        response: DynamicToolResponse {
            call_id: call.id.clone(),
            content: vec![DynamicToolOutput::Text {
                text: "found".into(),
            }],
            success: true,
        },
    };
    let output = composition
        .tools
        .resolve_execution_interaction(&call, &request, &response)
        .unwrap();
    assert!(matches!(
        output,
        Some(ToolExecutionOutput::SuccessContent(content))
            if content == vec![ash_protocol::ContentPart::Text("found".into())]
    ));
}

#[test]
fn changed_same_name_definition_cannot_claim_an_old_interaction() {
    let old = compose_dynamic_tools(vec![specification("Old definition.")])
        .unwrap()
        .unwrap();
    let current = compose_dynamic_tools(vec![specification("Changed definition.")])
        .unwrap()
        .unwrap();
    let call = call();
    let request = old.tools.execution_interaction(&call).unwrap().unwrap();
    let response = AgentResponse::DynamicTool {
        response: DynamicToolResponse {
            call_id: call.id.clone(),
            content: vec![DynamicToolOutput::Text {
                text: "stale".into(),
            }],
            success: true,
        },
    };
    let error = current
        .tools
        .resolve_execution_interaction(&call, &request, &response)
        .unwrap_err();
    assert!(error.to_string().contains("frozen Tool Call binding"));
}
