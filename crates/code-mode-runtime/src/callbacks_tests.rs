use crate::globals;
use crate::session::RuntimeState;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::CodeModeToolKind;
use ash_code_mode_protocol::EnabledTool;
use ash_code_mode_protocol::NestedToolCall;
use ash_code_mode_protocol::OutputItem;
use ash_code_mode_protocol::RuntimeNotification;
use ash_code_mode_protocol::ToolInvoker;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;

#[derive(Default)]
struct Invoker {
    calls: Mutex<Vec<NestedToolCall>>,
    notifications: Mutex<Vec<RuntimeNotification>>,
}

impl ToolInvoker for Invoker {
    fn invoke(&self, call: NestedToolCall) -> Result<serde_json::Value, String> {
        self.calls.lock().unwrap().push(call);
        Ok(serde_json::Value::Null)
    }

    fn notify(&self, notification: RuntimeNotification) -> Result<(), String> {
        self.notifications.lock().unwrap().push(notification);
        Ok(())
    }
}

// Keep JavaScript running so this test checks host admission independently
// of when V8 processes its termination interrupt.
fn mark_exit(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    scope.get_slot_mut::<RuntimeState>().unwrap().exit_requested = true;
    retval.set(args.get(0));
}

#[test]
fn callbacks_admit_no_effects_after_exit_including_during_value_conversion() {
    for source in [
        r#"markExit(); text('late'); image('data:image/png;base64,AAA'); store('phase', 'late'); notify('late'); tools.echo({}); yield_control();"#,
        r#"text({toJSON() { return markExit('late'); }});"#,
        r#"notify({toJSON() { return markExit('late'); }});"#,
        r#"store('phase', {toJSON() { return markExit('late'); }});"#,
        r#"store({toString() { return markExit('phase'); }}, {toJSON() { throw Error('must not convert'); }});"#,
        r#"tools.echo({toJSON() { return markExit({late: true}); }});"#,
        r#"image({get image_url() { return markExit('data:image/png;base64,AAA'); }, get detail() { throw Error('must not read'); }});"#,
        r#"image({image_url: 'data:image/png;base64,AAA', get detail() { return markExit('auto'); }});"#,
        r#"throw {get stack() { return markExit(undefined); }, toString() { throw Error('must not format'); }};"#,
    ] {
        v8_runtime::ensure_v8_initialized().unwrap();
        let isolate = &mut v8::Isolate::new(
            v8::Isolate::create_params()
                .array_buffer_allocator(v8_runtime::array_buffer_allocator()),
        );
        v8::scope!(let scope, isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        let invoker = Arc::new(Invoker::default());
        let (tool_completion_tx, tool_completion_rx) = mpsc::channel();
        scope.set_slot(RuntimeState {
            invoker: invoker.clone(),
            cell_id: CellId::from_internal("guards"),
            tool_call_id: "outer".into(),
            enabled_tools: vec![EnabledTool {
                global_name: "echo".into(),
                tool_name: "echo".into(),
                description: "Echo".into(),
                kind: CodeModeToolKind::Function,
                input_schema: serde_json::json!({"type": "object"}),
            }],
            stored_values: BTreeMap::new(),
            stored_value_writes: BTreeMap::new(),
            output_items: Vec::new(),
            output_bytes: 0,
            max_output_bytes: 1024,
            max_nested_calls: 10,
            next_tool_call_id: 1,
            tool_completion_tx,
            tool_completion_rx,
            pending_tool_calls: BTreeMap::new(),
            yield_requested: false,
            yield_resolver: None,
            exit_requested: false,
        });
        globals::install_globals(scope).unwrap();
        let mark_exit = v8::Function::new(scope, mark_exit).unwrap();
        let key = v8::String::new(scope, "markExit").unwrap();
        context
            .global(scope)
            .set(scope, key.into(), mark_exit.into());
        let script = v8::String::new(
            scope,
            &format!("store('phase', 'before'); text('before'); {source}"),
        )
        .unwrap();
        let tc = std::pin::pin!(v8::TryCatch::new(scope));
        let mut tc = tc.init();
        let script = v8::Script::compile(&tc, script, None).unwrap();
        let result = script.run(&tc);
        if source.starts_with("throw") {
            assert!(result.is_none());
            let exception = tc.exception().unwrap();
            assert_eq!(crate::value::value_to_error_text(&mut tc, exception), "");
        } else {
            assert!(result.is_some(), "{source}");
        }
        let state = tc.get_slot::<RuntimeState>().unwrap();
        assert!(state.exit_requested, "{source}");
        assert_eq!(
            state.stored_values,
            BTreeMap::from([("phase".into(), serde_json::json!("before"))]),
            "{source}"
        );
        assert_eq!(
            state.stored_value_writes,
            BTreeMap::from([("phase".into(), Some(serde_json::json!("before")))]),
            "{source}"
        );
        assert_eq!(
            state.output_items,
            vec![OutputItem::Text {
                text: "before".into()
            }],
            "{source}"
        );
        assert_eq!(state.next_tool_call_id, 1, "{source}");
        assert!(state.pending_tool_calls.is_empty(), "{source}");
        assert!(!state.yield_requested, "{source}");
        assert!(state.yield_resolver.is_none(), "{source}");
        assert!(invoker.calls.lock().unwrap().is_empty(), "{source}");
        assert!(invoker.notifications.lock().unwrap().is_empty(), "{source}");
    }
}
