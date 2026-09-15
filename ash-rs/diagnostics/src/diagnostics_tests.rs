#[test]
fn retains_bounded_facts_without_losing_totals() {
    let diagnostics = super::Diagnostics::default();
    for _ in 0..300 {
        diagnostics.record(super::Observation {
            activity: super::Activity::Rpc,
            outcome: super::Outcome::Succeeded,
            elapsed_ms: 2,
        });
    }
    let snapshot = diagnostics.snapshot(Default::default());
    assert_eq!(snapshot.recent.len(), 256);
    assert_eq!(snapshot.activities[&super::Activity::Rpc].count, 300);
    assert_eq!(snapshot.activities[&super::Activity::Rpc].elapsed_ms, 600);
    let json = serde_json::to_value(snapshot).unwrap();
    assert_eq!(
        json.as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["activities", "build", "recent", "responses", "usage"]
    );
}

#[test]
fn response_evidence_is_bounded_and_snapshots_are_immutable() {
    use response_debug_context::ResponseDiagnostic;
    use response_debug_context::ResponseDiagnosticSink;
    use response_debug_context::ResponseOperation;
    let diagnostics = super::Diagnostics::default();
    for attempts in 0..70 {
        let mut record = ResponseDiagnostic::new(ResponseOperation::Model);
        record.attempts = attempts;
        diagnostics.record_response(record);
    }
    let snapshot = diagnostics.snapshot(Default::default());
    assert_eq!(snapshot.responses.len(), 64);
    assert_eq!(snapshot.responses[0].attempts, 6);
    diagnostics.record_response(ResponseDiagnostic::new(ResponseOperation::ModelCatalog));
    assert_eq!(snapshot.responses.last().unwrap().attempts, 69);
    assert_eq!(
        diagnostics
            .snapshot(Default::default())
            .responses
            .last()
            .unwrap()
            .operation,
        ResponseOperation::ModelCatalog
    );
}
