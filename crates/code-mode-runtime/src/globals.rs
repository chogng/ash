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
    let yield_control = v8::Function::new(scope, callbacks::yield_callback)
        .ok_or_else(|| "failed to create Code Mode helper function".to_string())?;
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
    let function = v8::Function::new(scope, callback)
        .ok_or_else(|| "failed to create Code Mode helper function".to_string())?;
    set_global(scope, global, name, function.into())
}

fn build_tools<'s>(scope: &v8::PinScope<'s, '_>) -> Result<v8::Local<'s, v8::Object>, String> {
    let tools = v8::Object::with_prototype_and_properties(scope, v8::null(scope).into(), &[], &[]);
    let enabled_tools = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.enabled_tools.as_slice())
        .unwrap_or_default();
    for (index, tool) in enabled_tools.iter().enumerate() {
        let key = v8::String::new(scope, &tool.global_name)
            .ok_or_else(|| "failed to allocate Code Mode tool name".to_string())?;
        let index = u32::try_from(index).map_err(|_| "too many Code Mode tools")?;
        let data = v8::Integer::new_from_unsigned(scope, index);
        let function = v8::Function::builder(callbacks::tool_callback)
            .data(data.into())
            .build(scope)
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolMetadata<'a> {
    name: &'a str,
    tool_name: &'a str,
    description: &'a str,
    input_schema: &'a serde_json::Value,
}

fn build_all_tools<'s>(scope: &v8::PinScope<'s, '_>) -> Result<v8::Local<'s, v8::Value>, String> {
    let enabled_tools = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.enabled_tools.as_slice())
        .unwrap_or_default();
    // Borrow the session metadata and retain the public field order during serialization.
    let metadata: Vec<_> = enabled_tools
        .iter()
        .map(|tool| ToolMetadata {
            name: &tool.global_name,
            tool_name: &tool.tool_name,
            description: &tool.description,
            input_schema: &tool.input_schema,
        })
        .collect();
    crate::value::json_to_v8(scope, &metadata)
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
