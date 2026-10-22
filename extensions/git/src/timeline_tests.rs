use super::TimelineOptions;
use super::page_size;
use serde_json::json;

#[test]
fn page_limits_bound_each_request_without_changing_opaque_backend_cursors() {
    let cursor = "opaque-backend-snapshot:rename-path:offset";
    let options: TimelineOptions =
        serde_json::from_value(json!({"cursor":cursor,"limit":7})).unwrap();
    assert_eq!(page_size(&options).unwrap(), 7);
    assert_eq!(options.cursor.as_deref(), Some(cursor));
    let options: TimelineOptions = serde_json::from_value(json!({"limit":100_000})).unwrap();
    assert_eq!(page_size(&options).unwrap(), 1000);
    let options: TimelineOptions =
        serde_json::from_value(json!({"limit":{"timestamp":100,"id":"commit"}})).unwrap();
    assert_eq!(page_size(&options).unwrap(), 50);
}

#[test]
fn malformed_or_zero_page_limits_are_rejected_before_backend_queries() {
    for options in [
        json!({"limit":-1}),
        json!({"limit":1.5}),
        json!({"cursor":42}),
        json!({"limit":{"timestamp":"bad"}}),
    ] {
        assert!(serde_json::from_value::<TimelineOptions>(options).is_err());
    }
    let zero: TimelineOptions = serde_json::from_value(json!({"limit":0})).unwrap();
    assert!(page_size(&zero).is_err());
}
