use super::*;

fn reply(client: &mut DebugClient, request: &Value, success: bool, body: Value) {
    client.accept(&json!({"seq":0,"type":"response","command":request["command"],"request_seq":request["seq"],"success":success,"body":body,"message":"expression failed"})).unwrap();
}
#[test]
fn stack_inspection_uses_explicit_signed_selection_without_global_focus() {
    let mut jobs = Inspections::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, request) = jobs
        .start(
            &mut client,
            1,
            DebugInspection::Stack {
                thread_id: Some(-1),
            },
        )
        .unwrap();
    reply(
        &mut client,
        &request,
        true,
        json!({"threads":[{"id":2,"name":"other"},{"id":-1,"name":"selected"}]}),
    );
    let stack = jobs.progress(&mut client, 1).unwrap().remove(0);
    assert_eq!(stack["arguments"]["threadId"], -1);
    reply(
        &mut client,
        &stack,
        true,
        json!({"stackFrames":[{"id":0,"name":"main","line":1,"column":1}]}),
    );
    assert!(jobs.progress(&mut client, 1).unwrap().is_empty());
    let DebugInspectionResult::Complete {
        value: DebugInspectionValue::Stack {
            thread_id, frames, ..
        },
    } = jobs.read(id, 1).unwrap()
    else {
        panic!("stack did not complete")
    };
    assert_eq!(thread_id, Some(-1));
    assert_eq!(frames[0]["id"], 0);
    assert!(jobs.read(id, 1).is_err());
}
#[test]
fn frame_inspection_keeps_other_scopes_when_one_variable_request_fails() {
    let mut jobs = Inspections::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, request) = jobs
        .start(&mut client, 1, DebugInspection::Frame { frame_id: 11 })
        .unwrap();
    reply(
        &mut client,
        &request,
        true,
        json!({"scopes":[{"name":"empty","variablesReference":0},{"name":"bad","variablesReference":10},{"name":"good","variablesReference":20}]}),
    );
    let bad = jobs.progress(&mut client, 1).unwrap().remove(0);
    assert_eq!(bad["arguments"]["variablesReference"], 10);
    reply(&mut client, &bad, false, Value::Null);
    let good = jobs.progress(&mut client, 1).unwrap().remove(0);
    reply(
        &mut client,
        &good,
        true,
        json!({"variables":[{"name":"answer","value":"42","variablesReference":0}]}),
    );
    jobs.progress(&mut client, 1).unwrap();
    let DebugInspectionResult::Complete {
        value: DebugInspectionValue::Frame { scopes },
    } = jobs.read(id, 1).unwrap()
    else {
        panic!("frame did not complete")
    };
    assert!(scopes[0].variables.is_empty());
    assert!(scopes[1].error.is_some());
    assert_eq!(scopes[2].variables[0]["value"], "42");
}
#[test]
fn watch_failures_are_per_expression_and_success_is_not_replayed() {
    let mut jobs = Inspections::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, request) = jobs
        .start(
            &mut client,
            1,
            DebugInspection::Watch {
                expressions: vec!["bad".into(), "answer".into()],
                frame_id: Some(0),
            },
        )
        .unwrap();
    assert_eq!(request["arguments"]["frameId"], 0);
    reply(&mut client, &request, false, Value::Null);
    let next = jobs.progress(&mut client, 1).unwrap().remove(0);
    assert_eq!(next["arguments"]["expression"], "answer");
    reply(
        &mut client,
        &next,
        true,
        json!({"result":"42","variablesReference":0}),
    );
    assert!(jobs.progress(&mut client, 1).unwrap().is_empty());
    let DebugInspectionResult::Complete {
        value: DebugInspectionValue::Watch { values },
    } = jobs.read(id, 1).unwrap()
    else {
        panic!("watch did not complete")
    };
    assert!(values[0].error.is_some());
    assert_eq!(values[1].result.as_ref().unwrap()["result"], "42");
    assert!(jobs.progress(&mut client, 1).unwrap().is_empty());
}
#[test]
fn invalidation_discards_the_chain_and_drains_late_responses_without_next_requests() {
    let mut jobs = Inspections::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, request) = jobs
        .start(&mut client, 1, DebugInspection::Stack { thread_id: None })
        .unwrap();
    assert!(matches!(
        jobs.read(id, 2).unwrap(),
        DebugInspectionResult::Invalidated
    ));
    reply(&mut client, &request, true, json!({"threads":[{"id":1}]}));
    assert!(jobs.progress(&mut client, 2).unwrap().is_empty());
    assert!(jobs.retired.is_empty());
}
#[test]
fn a_completed_result_from_an_old_pause_is_still_invalidated() {
    let mut jobs = Inspections::new();
    let mut client = DebugClient::new(Duration::from_secs(15));
    let (id, request) = jobs
        .start(
            &mut client,
            1,
            DebugInspection::Variables {
                variables_reference: 1,
            },
        )
        .unwrap();
    reply(&mut client, &request, true, json!({"variables":[]}));
    jobs.progress(&mut client, 1).unwrap();
    assert!(matches!(
        jobs.read(id, 2).unwrap(),
        DebugInspectionResult::Invalidated
    ));
}
