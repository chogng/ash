use super::ExecRunId;

#[test]
fn run_ids_reject_empty_input_during_construction_and_deserialization() {
    assert!(ExecRunId::new("   ").is_err());
    assert!(serde_json::from_str::<ExecRunId>(r#"""#).is_err());
}

#[test]
fn generated_run_ids_are_distinct_and_round_trip() {
    let first = ExecRunId::generate();
    let second = ExecRunId::generate();
    assert_ne!(first, second);
    let encoded = serde_json::to_string(&first).unwrap();
    assert_eq!(serde_json::from_str::<ExecRunId>(&encoded).unwrap(), first);
}
