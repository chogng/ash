use super::DebugAdapterStartParams;
use serde_json::json;

#[test]
fn debug_adapter_start_roundtrips_executable_and_closed_connection_descriptors() {
    for value in [
        json!({"program":"adapter","arguments":["$HOME",""],"env":{"PATH":null}}),
        json!({"connection":{"type":"server","port":4711},"arguments":[]}),
        json!({"connection":{"type":"server","port":4711,"host":"::1"},"arguments":[]}),
        json!({"connection":{"type":"namedPipe","path":"/tmp/adapter.sock"},"arguments":[]}),
        json!({"connection":{"type":"client"},"arguments":[]}),
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

#[test]
fn managed_request_arguments_keep_omission_distinct_from_json_null() {
    for arguments in [None, Some(json!(null)), Some(json!({"literal":"$HOME"}))] {
        let mut value = json!({"sessionId":"session","command":"custom"});
        if let Some(arguments) = arguments {
            value["arguments"] = arguments;
        }
        let decoded: super::DebugSessionRequestParams =
            serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    assert!(
        serde_json::from_value::<super::DebugSessionRequestParams>(
            json!({"sessionId":"s","command":"custom","sequence":1})
        )
        .is_err()
    );
}

#[test]
fn runtime_intents_and_inspection_queries_have_closed_generated_shapes() {
    use super::DebugBreakpointsSetParams;
    use super::DebugInspectionStartParams;
    for value in [
        json!({"sessionId":"s","version":1,"intents":[{"id":"source","enabled":true,"location":{"kind":"source","source":{"sourceReference":7},"line":1},"condition":"answer > 0"}]}),
        json!({"sessionId":"s","version":2,"intents":[{"id":"memory","enabled":false,"location":{"kind":"data","dataId":"address","accessType":"readWrite","adapterType":"rust","canPersist":false,"sessionId":"public"}}]}),
    ] {
        let parsed: DebugBreakpointsSetParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
    for query in [
        json!({"kind":"stack","threadId":-1}),
        json!({"kind":"frame","frameId":0}),
        json!({"kind":"variables","variablesReference":7}),
        json!({"kind":"watch","expressions":["answer"],"frameId":11}),
    ] {
        let value = json!({"sessionId":"s","inspectionRevision":3,"query":query});
        let parsed: DebugInspectionStartParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
    assert!(serde_json::from_value::<DebugInspectionStartParams>(json!({"sessionId":"s","inspectionRevision":3,"query":{"kind":"frame","frameId":1,"unknown":true}})).is_err());
    assert!(serde_json::from_value::<DebugBreakpointsSetParams>(json!({"sessionId":"s","version":1,"intents":[{"id":"bad","enabled":true,"location":{"kind":"data","dataId":"x","accessType":"execute","adapterType":"rust","canPersist":true}}]})).is_err());
}

#[test]
fn initial_exception_selection_distinguishes_defaults_from_an_explicit_empty_selection() {
    let omitted: super::DebugSessionConfigureParams =
        serde_json::from_value(json!({"sessionId":"s"})).unwrap();
    let cleared: super::DebugSessionConfigureParams =
        serde_json::from_value(json!({"sessionId":"s","exceptionFilters":[]})).unwrap();
    assert_eq!(omitted.exception_filters, None);
    assert_eq!(cleared.exception_filters, Some(vec![]));
    assert!(
        serde_json::from_value::<super::DebugSessionLifecycleParams>(
            json!({"id":"s","action":"delete"})
        )
        .is_err()
    );
}
