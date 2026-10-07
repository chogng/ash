use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub(crate) fn generate(schema: &Value) -> String {
    // The decoder validates named definitions, never the exported schema's aggregate root.
    let mut runtime_schema = serde_json::json!({ "$defs": schema["$defs"] });
    retain_decoder_definitions(&mut runtime_schema, DECODER_ROOTS);
    remove_annotations(&mut runtime_schema);
    compact_definition_names(&mut runtime_schema, DECODER_ROOTS);
    // With preserve_order, removing annotations can swap the remaining object keys.
    runtime_schema.sort_all_objects();
    let schema =
        serde_json::to_string(&runtime_schema).expect("protocol schema must serialize as JSON");
    let schema_literal =
        serde_json::to_string(&schema).expect("protocol schema JSON must serialize as a string");
    include_str!("typescript_decoder.template.ts")
        .replace("__PROTOCOL_SCHEMA__", &schema_literal)
        .replace("\r\n", "\n")
}

/// Documentation remains in the exported schema; decoding only ships validation data.
/// Visit schema positions explicitly: a payload property or enum value named `description`
/// is application data and must never be removed by a recursive object-key filter.
fn remove_annotations(schema: &mut Value) {
    visit_schema(schema, &mut |object| {
        for annotation in ["description", "title", "$comment", "examples", "default"] {
            object.remove(annotation);
        }
    });
}

const DECODER_ROOTS: &[&str] = &[
    "AppServerListenInfo",
    "ClientRequestSchema",
    "ClientResultSchema",
    "ServerNotificationSchema",
    "HostRequestSchema",
    "HostResultSchema",
    "AppServerError",
    "JsonRpcError",
];

/// Only decoder entry points need public names; internal references never enter the wire contract.
/// Rewrite schema references, not payload keys or literal values that happen to contain `$ref`.
fn compact_definition_names(schema: &mut Value, roots: &[&str]) {
    let mut names: Vec<String> = schema["$defs"]
        .as_object()
        .expect("decoder schema must contain definitions")
        .keys()
        .cloned()
        .collect();
    names.sort();
    let aliases: BTreeMap<String, String> = names
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            let alias = if roots.contains(&name.as_str()) {
                name.clone()
            } else {
                index.to_string()
            };
            (name, alias)
        })
        .collect();
    visit_schema(schema, &mut |object| {
        if let Some(reference) = object.get_mut("$ref") {
            let target = reference
                .as_str()
                .and_then(|value| value.strip_prefix("#/$defs/"))
                .expect("decoder schema references must use local definitions");
            let alias = aliases
                .get(target)
                .expect("decoder schema reference must resolve to a definition");
            *reference = Value::String(format!("#/$defs/{alias}"));
        }
    });
    let definitions = schema["$defs"]
        .as_object_mut()
        .expect("decoder schema must contain definitions");
    for (name, definition) in std::mem::take(definitions) {
        definitions.insert(aliases[&name].clone(), definition);
    }
}

/// Keep the transitive reference closure of the decoder entry points, including cycles.
fn retain_decoder_definitions(schema: &mut Value, roots: &[&str]) {
    let definitions = schema["$defs"]
        .as_object_mut()
        .expect("protocol schema must contain definitions");
    let mut retained = BTreeSet::new();
    let mut pending: Vec<String> = roots.iter().map(|name| (*name).to_owned()).collect();
    while let Some(name) = pending.pop() {
        if !retained.insert(name.clone()) {
            continue;
        }
        let definition = definitions
            .get_mut(&name)
            .expect("decoder schema reference must resolve to a definition");
        visit_schema(definition, &mut |object| {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                let target = reference
                    .strip_prefix("#/$defs/")
                    .expect("decoder schema references must use local definitions");
                pending.push(target.to_owned());
            }
        });
    }
    definitions.retain(|name, _| retained.contains(name));
}

// Only schema positions are traversed: const/enum payloads may contain literal $ref keys.
fn visit_schema(schema: &mut Value, visitor: &mut impl FnMut(&mut Map<String, Value>)) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    visitor(object);
    for keyword in [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
    ] {
        if let Some(children) = object.get_mut(keyword).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                visit_schema(child, visitor);
            }
        }
    }
    for keyword in ["oneOf", "anyOf", "allOf", "prefixItems"] {
        if let Some(children) = object.get_mut(keyword).and_then(Value::as_array_mut) {
            for child in children {
                visit_schema(child, visitor);
            }
        }
    }
    for keyword in [
        "items",
        "additionalProperties",
        "unevaluatedProperties",
        "contains",
        "not",
        "propertyNames",
        "if",
        "then",
        "else",
    ] {
        if let Some(child) = object.get_mut(keyword) {
            visit_schema(child, visitor);
        }
    }
}

#[cfg(test)]
#[path = "typescript_decoder_tests.rs"]
mod tests;
