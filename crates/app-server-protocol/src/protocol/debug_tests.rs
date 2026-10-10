use super::DebugAdapterStartParams;
use serde_json::json;

#[test]
fn debug_adapter_start_roundtrips_executable_and_closed_connection_descriptors() {
    for value in [
        json!({"program":"adapter","arguments":["$HOME",""],"env":{"PATH":null}}),
        json!({"connection":{"type":"server","port":4711},"arguments":[]}),
        json!({"connection":{"type":"server","port":4711,"host":"::1"},"arguments":[]}),
        json!({"connection":{"type":"namedPipe","path":"/tmp/adapter.sock"},"arguments":[]}),
    ] {
        let decoded: DebugAdapterStartParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    for value in [
        json!({"connection":{"type":"server","port":65536},"arguments":[]}),
        json!({"connection":{"type":"server","port":1,"unknown":true},"arguments":[]}),
        json!({"connection":{"type":"namedPipe","path":"socket","host":"localhost"},"arguments":[]}),
        json!({"connection":{"type":"other"},"arguments":[]}),
    ] {
        assert!(serde_json::from_value::<DebugAdapterStartParams>(value).is_err());
    }
}
