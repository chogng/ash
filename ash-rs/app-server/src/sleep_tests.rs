use super::*;

struct InhibitedModel;

impl ModelService for InhibitedModel {
    fn invoke(
        &self,
        _: core_api::ModelSelection<'_>,
        _: &ModelRequest,
        _: &CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let output = std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let assertions = String::from_utf8(output.stdout).unwrap();
        let pid = format!("pid {}(", std::process::id());
        assert_eq!(
            assertions
                .lines()
                .filter(|line| {
                    line.contains(&pid)
                        && line.contains("PreventUserIdleSystemSleep")
                        && line.contains("Ash is executing an agent task")
                })
                .count(),
            1,
            "{assertions}"
        );
        Ok(ModelResponse {
            output: vec![ResponseItem::Text("done".into())],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

#[test]
fn rpc_turn_holds_the_process_sleep_assertion_during_model_execution() {
    let server = server_with_model(Arc::new(InhibitedModel));
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let session = create_session(&server, &mut connection, 2, "session");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread = create_thread(&server, &mut connection, 3, "thread", session_id, 1);
    let thread_id = thread["result"]["value"]["threadId"].as_str().unwrap();
    let response = call(
        &server,
        &mut connection,
        serde_json::json!({
            "jsonrpc":"2.0", "id":4, "method":"session/request",
            "params":{
                "commandId":"turn", "sessionId":session_id,
                "request":{
                    "type":"startTurn", "expectedSequence":1, "threadId":thread_id,
                    "input":[{"type":"text","text":"hello"}]
                }
            }
        }),
    );
    assert!(response.get("error").is_none(), "{response}");
    wait_for_latest_turn(&server, thread_id, TurnStatus::Completed);
}
