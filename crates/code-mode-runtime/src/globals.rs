use crate::callbacks;
use crate::session::RuntimeState;

pub(super) fn install_globals(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String> {
    let global = scope.get_current_context().global(scope);
    for name in [
        "console",
        "Atomics",
        "SharedArrayBuffer",
        "WebAssembly",
        "fetch",
        "process",
        "require",
        "Deno",
        "Bun",
    ] {
        delete_global(scope, global, name)?;
    }

    let tools = build_tools(scope)?;
    let all_tools = build_all_tools(scope)?;
    set_global(scope, global, "tools", tools.into())?;
    set_global(scope, global, "ALL_TOOLS", all_tools)?;
    install_helper(scope, global, "text", callbacks::text_callback)?;
    install_helper(scope, global, "image", callbacks::image_callback)?;
    install_helper(scope, global, "store", callbacks::store_callback)?;
    install_helper(scope, global, "load", callbacks::load_callback)?;
    install_helper(scope, global, "notify", callbacks::notify_callback)?;
    let yield_control = callbacks::helper_function(scope, callbacks::yield_callback)?;
    set_global(scope, global, "yield_control", yield_control.into())?;
    set_global(scope, global, "yield", yield_control.into())?;
    install_helper(scope, global, "exit", callbacks::exit_callback)?;
    Ok(())
}

fn install_helper<'s, F>(
    scope: &mut v8::PinScope<'s, '_>,
    global: v8::Local<'s, v8::Object>,
    name: &str,
    callback: F,
) -> Result<(), String>
where
    F: v8::MapFnTo<v8::FunctionCallback>,
{
    let function = callbacks::helper_function(scope, callback)?;
    set_global(scope, global, name, function.into())
}

fn build_tools<'s>(scope: &mut v8::PinScope<'s, '_>) -> Result<v8::Local<'s, v8::Object>, String> {
    let tools = v8::Object::new(scope);
    if tools.set_prototype(scope, v8::null(scope).into()) != Some(true) {
        return Err("failed to isolate Code Mode tool namespace".into());
    }
    let enabled_tools = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.enabled_tools.clone())
        .unwrap_or_default();
    for (index, tool) in enabled_tools.iter().enumerate() {
        let key = v8::String::new(scope, &tool.global_name)
            .ok_or_else(|| "failed to allocate Code Mode tool name".to_string())?;
        let data = v8::String::new(scope, &index.to_string())
            .ok_or_else(|| "failed to allocate Code Mode tool callback data".to_string())?;
        let function = v8::FunctionTemplate::builder(callbacks::tool_callback)
            .data(data.into())
            .build(scope)
            .get_function(scope)
            .ok_or_else(|| "failed to create Code Mode tool function".to_string())?;
        if tools.set(scope, key.into(), function.into()) != Some(true) {
            return Err(format!(
                "failed to expose Code Mode tool `{}`",
                tool.global_name
            ));
        }
    }
    Ok(tools)
}

fn build_all_tools<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<v8::Local<'s, v8::Value>, String> {
    let enabled_tools = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.enabled_tools.clone())
        .unwrap_or_default();
    let array = v8::Array::new(scope, enabled_tools.len() as i32);
    for (index, tool) in enabled_tools.iter().enumerate() {
        let item = v8::Object::new(scope);
        set_object_string(scope, item, "name", &tool.global_name)?;
        set_object_string(scope, item, "toolName", &tool.tool_name)?;
        set_object_string(scope, item, "description", &tool.description)?;
        let schema = crate::value::json_to_v8(scope, &tool.input_schema)?;
        let schema_key = v8::String::new(scope, "inputSchema")
            .ok_or_else(|| "failed to allocate ALL_TOOLS schema key".to_string())?;
        if item.set(scope, schema_key.into(), schema) != Some(true) {
            return Err("failed to set ALL_TOOLS input schema".into());
        }
        if array.set_index(scope, index as u32, item.into()) != Some(true) {
            return Err("failed to append ALL_TOOLS metadata".into());
        }
    }
    Ok(array.into())
}

fn set_object_string(
    scope: &mut v8::PinScope<'_, '_>,
    object: v8::Local<'_, v8::Object>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let key = v8::String::new(scope, key)
        .ok_or_else(|| "failed to allocate ALL_TOOLS key".to_string())?;
    let value = v8::String::new(scope, value)
        .ok_or_else(|| "failed to allocate ALL_TOOLS value".to_string())?;
    if object.set(scope, key.into(), value.into()) == Some(true) {
        Ok(())
    } else {
        Err("failed to set ALL_TOOLS metadata".into())
    }
}

fn set_global(
    scope: &mut v8::PinScope<'_, '_>,
    global: v8::Local<'_, v8::Object>,
    name: &str,
    value: v8::Local<'_, v8::Value>,
) -> Result<(), String> {
    let key = v8::String::new(scope, name)
        .ok_or_else(|| format!("failed to allocate global `{name}`"))?;
    if global.set(scope, key.into(), value) == Some(true) {
        Ok(())
    } else {
        Err(format!("failed to set global `{name}`"))
    }
}

fn delete_global(
    scope: &mut v8::PinScope<'_, '_>,
    global: v8::Local<'_, v8::Object>,
    name: &str,
) -> Result<(), String> {
    let key = v8::String::new(scope, name)
        .ok_or_else(|| format!("failed to allocate global `{name}`"))?;
    if global.delete(scope, key.into()) == Some(true) {
        Ok(())
    } else {
        Err(format!("failed to remove global `{name}`"))
    }
}
