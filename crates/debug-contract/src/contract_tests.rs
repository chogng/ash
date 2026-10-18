use super::DebugBreakpointIntent;
use super::DebugInspection;
use super::DebugInspectionResult;
use super::DebugInspectionValue;
use super::DebugWatchValue;
use serde_json::json;

#[test]
fn domain_intents_and_queries_keep_closed_stable_field_names() {
    let value = json!({"id":"memory","enabled":true,"location":{"kind":"data","dataId":"address","accessType":"readWrite","adapterType":"rust","canPersist":false,"sessionId":"public"},"hitCondition":"2"});
    let point: DebugBreakpointIntent = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(point).unwrap(), value);
    assert!(
        serde_json::from_value::<DebugInspection>(json!({"kind":"frame","frameId":0,"threadId":2}))
            .is_err()
    );
    assert!(serde_json::from_value::<DebugInspection>(json!({"kind":"threads"})).is_err());
}

#[test]
fn inspection_completion_keeps_null_data_distinct_from_errors_and_invalidation() {
    let result = DebugInspectionResult::Complete {
        value: DebugInspectionValue::Watch {
            values: vec![DebugWatchValue {
                expression: "null".into(),
                result: Some(serde_json::Value::Null),
                error: None,
            }],
        },
    };
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({"state":"complete","value":{"kind":"watch","values":[{"expression":"null","result":null,"error":null}]}})
    );
    assert_eq!(
        serde_json::to_value(DebugInspectionResult::Invalidated).unwrap(),
        json!({"state":"invalidated"})
    );
}
