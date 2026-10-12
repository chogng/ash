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
fn section_reordering_keeps_uniqueness_at_the_boundary_without_an_unsupported_strict_keyword() {
    assert!(AppToolService::operation(&call(
        "reorder_section",
        json!({"section_id":"section-1","session_ids":["session-1","session-1"]})
    )).is_err());
    assert!(AppToolService::operation(&call(
        "reorder_section",
        json!({"section_id":"section-1","session_ids":["session-1","session-2"]})
    )).is_ok());
    for definition in definitions() {
        assert!(!definition.parameters.to_string().contains("\"uniqueItems\""));
    }
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

#[test]
fn task_tools_validate_identity_revision_and_bounded_output() {
    let definitions = definitions();
    for name in [
        "tasks_list",
        "tasks_run",
        "tasks_status",
        "tasks_output",
        "tasks_cancel",
    ] {
        assert!(
            definitions
                .iter()
                .any(|definition| definition.name.as_str() == name)
        );
    }
    assert!(
        !definitions
            .iter()
            .any(|definition| definition.name.as_str() == "tasks_describe")
    );
    let arguments = json!({"directory":"/repo","task_id":"check","revision":"a".repeat(64)});
    assert!(AppToolService::operation(&call("tasks_run", arguments.clone())).is_ok());
    assert!(
        AppToolService::new(Arc::new(Host))
            .prepare(&call("tasks_run", arguments))
            .is_err()
    );
    for (cursor, maximum) in [(0, 0), (0, 65537), (9007199254740992u64, 1)] {
        assert!(
            AppToolService::operation(&call(
                "tasks_output",
                json!({"directory":"/repo","run_id":"run","cursor":cursor,"max_characters":maximum})
            ))
            .is_err()
        );
    }
    assert!(
        AppToolService::operation(&call(
            "tasks_run",
            json!({"directory":"/repo","task_id":"check","revision":"stale"})
        ))
        .is_err()
    );
}

#[test]
fn configured_task_execution_requires_reviewed_authority() {
    let request = ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"exact task recipe"),
            ActionKind::SystemOperation,
            "Run check in /repo",
            capabilities("tasks_run"),
        ),
        ActionProvenance::new(ActionSource::BuiltInTool, "tasks_run"),
        SandboxCompatibility::NotApplicable {
            reason: "development terminal".into(),
        },
        ActionPolicyRevision::new(POLICY_REVISION),
    );
    assert!(matches!(
        AppToolPolicy
            .decide(
                &request,
                &ash_async_utils::CancellationSource::new().token()
            )
            .unwrap(),
        ExecutionDecision::AskUser(_)
    ));
    assert_eq!(
        request
            .action()
            .required_capabilities()
            .iter()
            .next()
            .unwrap()
            .kind(),
        &CapabilityKind::ProcessSpawn
    );
}
