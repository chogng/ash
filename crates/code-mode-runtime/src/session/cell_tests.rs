use super::RuntimeState;
use super::apply_tool_completion;
use crate::session::ToolCompletion;
use crate::tests::RecordingInvoker;
use ash_code_mode_protocol::CellId;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc;

#[test]
fn discarded_tool_response_is_collectible_before_cell_ends() {
    v8_runtime::ensure_v8_initialized().unwrap();
    let isolate = &mut v8::Isolate::new(
        v8::Isolate::create_params().array_buffer_allocator(v8_runtime::array_buffer_allocator()),
    );
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let (resolver, promise) = {
        v8::scope!(let scope, scope);
        let resolver = v8::PromiseResolver::new(scope).unwrap();
        (
            v8::Global::new(scope, resolver),
            v8::Global::new(scope, resolver.get_promise(scope)),
        )
    };
    let (tool_completion_tx, tool_completion_rx) = mpsc::channel();
    scope.set_slot(RuntimeState {
        invoker: Arc::new(RecordingInvoker::default()),
        cell_id: CellId::from_internal("collect-response"),
        tool_call_id: "outer".into(),
        enabled_tools: Vec::new(),
        stored_values: BTreeMap::new(),
        stored_value_writes: BTreeMap::new(),
        output_items: Vec::new(),
        output_bytes: 0,
        max_output_bytes: 1024,
        max_nested_calls: 1,
        next_tool_call_id: 2,
        tool_completion_tx,
        tool_completion_rx,
        pending_tool_calls: BTreeMap::from([("tool-1".into(), resolver)]),
        yield_requested: false,
        yield_resolver: None,
        exit_requested: false,
    });
    apply_tool_completion(
        scope,
        ToolCompletion {
            runtime_tool_call_id: "tool-1".into(),
            result: Ok(serde_json::json!({"value": "from-tool"})),
        },
    )
    .unwrap();
    scope.perform_microtask_checkpoint();
    scope.low_memory_notification();

    let weak_response = {
        v8::scope!(let scope, scope);
        let promise = v8::Local::new(scope, &promise);
        assert_eq!(promise.state(), v8::PromiseState::Fulfilled);
        let response = promise.result(scope);
        let json = v8::json::stringify(scope, response).unwrap();
        assert_eq!(json.to_rust_string_lossy(scope), r#"{"value":"from-tool"}"#);
        v8::Weak::new(scope, response)
    };
    drop(promise);
    scope.low_memory_notification();
    assert!(
        weak_response.is_empty(),
        "discarded tool response is still rooted"
    );
}
