use super::*;

struct Host;
impl AppToolHost for Host {
    fn execute(
        &self,
        _: AppToolOperation,
        _: &AppToolContext,
        _: &CancellationToken,
    ) -> Result<Value, CoreError> {
        Ok(json!({"executed":true}))
    }
}
fn call(name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        id: ToolCallId::new("call-1").unwrap(),
        name: ToolName::new(name).unwrap(),
        arguments,
    }
}

#[test]
fn parser_rejects_spoofed_identity_and_ambiguous_operations() {
    assert!(
        AppToolService::operation(&call(
            "list_threads",
            json!({"tool":"create_thread","title":"hidden"})
        ))
        .is_err()
    );
    assert!(AppToolService::operation(&call("create_thread", json!({"title":""}))).is_err());
    assert!(
        AppToolService::operation(&call(
            "open_in_ash",
            json!({"target":{"type":"file","path":"/a","line":0}})
        ))
        .is_err()
    );
    assert!(AppToolService::operation(&call("list_threads", json!({"connection_id":7}))).is_err());
}
#[test]
fn automation_modes_use_the_complete_shared_contract() {
    let operation = AppToolService::operation(&call("automation_update", json!({"mode":"save","id":"automation-1","expected_revision":0,"status":"paused","definition":{"title":"Review","prompt":"Review changes","directory":"/repo","session":{"type":"new"},"schedule":{"type":"interval","anchor":0,"minutes":60}}}))).unwrap();
    assert!(matches!(
        operation,
        AppToolOperation::AutomationUpdate {
            operation: AutomationOperation::Save { .. }
        }
    ));
    assert!(
        AppToolService::operation(&call(
            "automation_update",
            json!({"mode":"list","id":"ignored"})
        ))
        .is_err()
    );
    let definition = definitions()
        .into_iter()
        .find(|definition| definition.name.as_str() == "automation_update")
        .unwrap();
    assert_eq!(definition.parameters["type"], "object");
    assert!(definition.parameters["properties"]["definition"]["anyOf"][0]["properties"]["session"]["anyOf"].is_array());
    assert!(!definition.parameters.to_string().contains("$ref"));
}
#[test]
fn managed_policy_does_not_accept_foreign_authority() {
    let tools = AppToolService::new(Arc::new(Host));
    let request = tools.prepare(&call("list_threads", json!({}))).unwrap();
    assert!(matches!(
        AppToolPolicy
            .decide(
                &request,
                &ash_async_utils::CancellationSource::new().token()
            )
            .unwrap(),
        ExecutionDecision::RunUnsandboxed { .. }
    ));
    let foreign = ActionReviewRequest::new(
        request.action().clone(),
        ActionProvenance::new(ActionSource::BuiltInTool, "shell"),
        request.sandbox().clone(),
        ActionPolicyRevision::new(POLICY_REVISION),
    );
    assert!(
        AppToolPolicy
            .decide(
                &foreign,
                &ash_async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
}
