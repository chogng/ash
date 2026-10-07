//! Canonical schema generation isolated from product runtime dependencies.

pub fn generate() -> String {
    let mut schema =
        serde_json::to_value(schemars::schema_for!(config::UserConfigDocument)).unwrap();
    schema["title"] = "Ash user configuration".into();
    schema["properties"]["schemaVersion"] = serde_json::json!({
        "type": "integer", "const": config::CONFIG_FILE_SCHEMA_VERSION
    });
    schema["required"] = serde_json::json!(["schemaVersion"]);
    // Keep the canonical file stable when another selected package enables preserve_order.
    schema.sort_all_objects();
    format!("{}\n", serde_json::to_string_pretty(&schema).unwrap())
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
