use serde_json::Value;

pub(crate) fn generate(schema: &Value) -> String {
    let mut runtime_schema = schema.clone();
    remove_annotations(&mut runtime_schema);
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
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    for annotation in ["description", "title", "$comment", "examples", "default"] {
        object.remove(annotation);
    }
    for keyword in [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
    ] {
        if let Some(children) = object.get_mut(keyword).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                remove_annotations(child);
            }
        }
    }
    for keyword in ["oneOf", "anyOf", "allOf", "prefixItems"] {
        if let Some(children) = object.get_mut(keyword).and_then(Value::as_array_mut) {
            for child in children {
                remove_annotations(child);
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
            remove_annotations(child);
        }
    }
}

#[cfg(test)]
#[path = "typescript_decoder_tests.rs"]
mod tests;
