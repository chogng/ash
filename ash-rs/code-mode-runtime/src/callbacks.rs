use crate::session::{RuntimeState, ToolCompletion};
use crate::value::v8_value_to_json;
use crate::value::{json_to_v8, normalize_image, serialize_output_text, throw_type_error};
use ash_code_mode_protocol::{NestedToolCall, OutputItem, RuntimeNotification};
use ash_protocol::ToolName;

pub(super) fn tool_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let Ok(index) = args.data().to_rust_string_lossy(scope).parse::<usize>() else {
        throw_type_error(scope, "invalid tool callback data");
        return;
    };
    let input = if args.length() == 0 {
        serde_json::Value::Null
    } else {
        match v8_value_to_json(scope, args.get(0)) {
            Ok(value) => value,
            Err(error) => {
                throw_type_error(scope, &error);
                return;
            }
        }
    };
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        throw_type_error(scope, "failed to create Code Mode tool Promise");
        return;
    };
    let promise = resolver.get_promise(scope);
    let resolver = v8::Global::new(scope, resolver);
    let (
        invoker,
        completion_tx,
        cell_id,
        parent_tool_call_id,
        global_name,
        tool_name,
        kind,
        runtime_tool_call_id,
    ) = {
        let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
            throw_type_error(scope, "runtime state unavailable");
            return;
        };
        if state.next_tool_call_id > state.max_nested_calls {
            throw_type_error(scope, "Code Mode nested tool call limit exceeded");
            return;
        }
        let Some(tool) = state.enabled_tools.get(index) else {
            throw_type_error(scope, "tool callback data is out of range");
            return;
        };
        let runtime_tool_call_id = format!("tool-{}", state.next_tool_call_id);
        state.next_tool_call_id = state.next_tool_call_id.saturating_add(1);
        state
            .pending_tool_calls
            .insert(runtime_tool_call_id.clone(), resolver);
        (
            state.invoker.clone(),
            state.tool_completion_tx.clone(),
            state.cell_id.clone(),
            state.tool_call_id.clone(),
            tool.global_name.clone(),
            tool.tool_name.clone(),
            tool.kind,
            runtime_tool_call_id,
        )
    };
    let tool_name = match ToolName::new(tool_name) {
        Ok(tool_name) => tool_name,
        Err(_) => {
            throw_type_error(
                scope,
                "Code Mode tool projection contains an invalid tool name",
            );
            if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
                state.pending_tool_calls.remove(&runtime_tool_call_id);
            }
            return;
        }
    };
    let call = NestedToolCall {
        cell_id,
        parent_tool_call_id,
        runtime_tool_call_id: runtime_tool_call_id.clone(),
        global_name,
        tool_name,
        kind,
        input,
    };
    std::thread::spawn(move || {
        let result = invoker.invoke(call);
        let _ = completion_tx.send(ToolCompletion {
            runtime_tool_call_id,
            result,
        });
    });
    retval.set(promise.into());
}

pub(super) fn text_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let text = match serialize_output_text(scope, value) {
        Ok(text) => text,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Some(state) = scope.get_slot_mut::<RuntimeState>()
        && let Err(error) = state.push_output(OutputItem::Text { text })
    {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn image_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let detail = if args.length() < 2 {
        None
    } else {
        let value = args.get(1);
        if value.is_null() || value.is_undefined() {
            None
        } else if value.is_string() {
            Some(value.to_rust_string_lossy(scope))
        } else {
            throw_type_error(scope, "image detail must be a string when provided");
            return;
        }
    };
    let item = match normalize_image(scope, value, detail) {
        Ok(item) => item,
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    if let Some(state) = scope.get_slot_mut::<RuntimeState>()
        && let Err(error) = state.push_output(item)
    {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn store_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
) {
    if args.length() < 2 {
        throw_type_error(scope, "store expects a key and a value");
        return;
    }
    let Some(key) = args.get(0).to_string(scope) else {
        throw_type_error(scope, "store key must be a string");
        return;
    };
    let key = key.to_rust_string_lossy(scope);
    let value = if args.get(1).is_undefined() {
        None
    } else {
        match v8_value_to_json(scope, args.get(1)) {
            Ok(value) => Some(value),
            Err(error) => {
                throw_type_error(scope, &error);
                return;
            }
        }
    };
    let error = if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
        let previous = match &value {
            Some(value) => state.stored_values.insert(key.clone(), value.clone()),
            None => state.stored_values.remove(&key),
        };
        match ash_code_mode_session::validate_values(&state.stored_values) {
            Ok(()) => {
                state.stored_value_writes.insert(key, value);
                None
            }
            Err(error) => {
                match previous {
                    Some(previous) => {
                        state.stored_values.insert(key, previous);
                    }
                    None => {
                        state.stored_values.remove(&key);
                    }
                }
                Some(error)
            }
        }
    } else {
        Some("runtime state unavailable".into())
    };
    if let Some(error) = error {
        throw_type_error(scope, &error);
    }
}

pub(super) fn load_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    if args.length() == 0 {
        throw_type_error(scope, "load expects a key");
        return;
    }
    let Some(key) = args.get(0).to_string(scope) else {
        throw_type_error(scope, "load key must be a string");
        return;
    };
    let key = key.to_rust_string_lossy(scope);
    let value = scope
        .get_slot::<RuntimeState>()
        .and_then(|state| state.stored_values.get(&key))
        .cloned();
    let Some(value) = value else {
        retval.set(v8::undefined(scope).into());
        return;
    };
    match json_to_v8(scope, &value) {
        Ok(value) => retval.set(value),
        Err(error) => throw_type_error(scope, &error),
    }
}

pub(super) fn notify_callback(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let value = if args.length() == 0 {
        v8::undefined(scope).into()
    } else {
        args.get(0)
    };
    let text = match serialize_output_text(scope, value) {
        Ok(text) if !text.trim().is_empty() => text,
        Ok(_) => {
            throw_type_error(scope, "notify expects non-empty text");
            return;
        }
        Err(error) => {
            throw_type_error(scope, &error);
            return;
        }
    };
    let (invoker, cell_id, tool_call_id) = {
        let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
            throw_type_error(scope, "runtime state unavailable");
            return;
        };
        let next_bytes = state
            .output_bytes
            .checked_add(text.len())
            .filter(|bytes| *bytes <= state.max_output_bytes);
        let Some(next_bytes) = next_bytes else {
            throw_type_error(scope, "Code Mode notification exceeds the output limit");
            return;
        };
        state.output_bytes = next_bytes;
        (
            state.invoker.clone(),
            state.cell_id.clone(),
            state.tool_call_id.clone(),
        )
    };
    if let Err(error) = invoker.notify(RuntimeNotification {
        cell_id,
        tool_call_id,
        text,
    }) {
        throw_type_error(scope, &error);
        return;
    }
    retval.set(v8::undefined(scope).into());
}

pub(super) fn yield_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    mut retval: v8::ReturnValue<v8::Value>,
) {
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        throw_type_error(scope, "failed to create Code Mode yield promise");
        return;
    };
    let promise = resolver.get_promise(scope);
    let resolver = v8::Global::new(scope, resolver);
    let Some(state) = scope.get_slot_mut::<RuntimeState>() else {
        throw_type_error(scope, "runtime state unavailable");
        return;
    };
    if state.yield_resolver.is_some() {
        throw_type_error(scope, "only one Code Mode yield may be pending");
        return;
    }
    state.yield_requested = true;
    state.yield_resolver = Some(resolver);
    retval.set(promise.into());
}

pub(super) fn exit_callback(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    _retval: v8::ReturnValue<v8::Value>,
) {
    if let Some(state) = scope.get_slot_mut::<RuntimeState>() {
        state.exit_requested = true;
    }
    // Request termination, then enter V8 to process the interrupt before returning
    // to the caller. Merely requesting it can allow straight-line JS to continue.
    scope.terminate_execution();
    if let Some(source) = v8::String::new(scope, "")
        && let Some(script) = v8::Script::compile(scope, source, None)
    {
        let _ = script.run(scope);
    }
}

pub(super) fn helper_function<'s, F>(
    scope: &mut v8::PinScope<'s, '_>,
    callback: F,
) -> Result<v8::Local<'s, v8::Function>, String>
where
    F: v8::MapFnTo<v8::FunctionCallback>,
{
    v8::FunctionTemplate::builder(callback)
        .build(scope)
        .get_function(scope)
        .ok_or_else(|| "failed to create Code Mode helper function".into())
}
