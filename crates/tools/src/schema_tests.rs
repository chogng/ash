use super::{ToolInputSchema, ToolSchema, ToolSchemaError};
use serde_json::json;

#[test]
fn function_input_schema_is_validated_and_digest_is_stable() {
    let value = json!({
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
        "additionalProperties": false
    });

    let first = ToolInputSchema::parse(value.clone()).expect("valid input schema");
    let second = ToolInputSchema::parse(value).expect("valid input schema");

    assert_eq!(first.as_schema().digest(), second.as_schema().digest());
}

#[test]
fn function_input_schema_requires_an_object_root() {
    let error = ToolInputSchema::parse(json!({"type": "string"}))
        .expect_err("string input schemas must be rejected");

    assert_eq!(error, ToolSchemaError::InputRootMustBeObject);
}

#[test]
fn schema_rejects_unsupported_references() {
    let error = ToolSchema::parse(json!({"$ref": "https://example.com/tool-schema"}))
        .expect_err("external references must be rejected");

    assert_eq!(error, ToolSchemaError::UnsupportedReference);
}

#[test]
fn schema_rejects_required_properties_missing_from_properties() {
    let error = ToolInputSchema::parse(json!({
        "type": "object",
        "properties": {},
        "required": ["query"]
    }))
    .expect_err("required property must exist");

    assert_eq!(
        error,
        ToolSchemaError::RequiredPropertyMissing("query".to_owned())
    );
}
