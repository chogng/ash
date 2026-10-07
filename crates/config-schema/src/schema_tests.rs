#[test]
fn checked_in_schema_matches_config_types() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/schema.json");
    assert_eq!(std::fs::read_to_string(path).unwrap(), super::generate());
}

#[test]
fn schema_preserves_strict_keys_and_feature_defaults() {
    let schema: serde_json::Value = serde_json::from_str(&super::generate()).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["properties"]["schemaVersion"]["const"],
        config::CONFIG_FILE_SCHEMA_VERSION
    );
    assert!(schema["properties"]["features"].is_object());
    assert!(schema["$defs"]["AgentConfig"].is_object());
}
