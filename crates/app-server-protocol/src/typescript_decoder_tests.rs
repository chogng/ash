use super::DECODER_ROOTS;
use super::compact_definition_names;
use super::deduplicate_definitions;
use super::remove_annotations;
use super::retain_decoder_definitions;
use serde_json::json;

#[test]
fn deduplication_keeps_public_roots_and_rewrites_schema_references_without_changing_literals() {
    let mut schema = json!({ "$defs": {
        "Root": { "type":"string" }, "OtherRoot": { "type":"string" },
        "Duplicate": { "type":"string" },
        "Object": { "type":"object", "properties": {
            "child": { "$ref":"#/$defs/Duplicate" },
            "literal": { "const": { "$ref":"#/$defs/Duplicate" } }
        }}
    }});
    deduplicate_definitions(&mut schema, &["Root", "OtherRoot"]);
    assert!(schema["$defs"].get("Root").is_some());
    assert!(schema["$defs"].get("OtherRoot").is_some());
    assert!(schema["$defs"].get("Duplicate").is_none());
    assert_eq!(
        schema["$defs"]["Object"]["properties"]["child"]["$ref"],
        "#/$defs/OtherRoot"
    );
    assert_eq!(
        schema["$defs"]["Object"]["properties"]["literal"]["const"]["$ref"],
        "#/$defs/Duplicate"
    );
}

#[test]
fn annotation_removal_preserves_validation_and_payload_property_names() {
    let mut schema = json!({
        "description":"Documentation",
        "$defs":{"Data":{"description":"Data docs","type":"object","required":["description"],"properties":{
            "description":{"description":"Field docs","type":"string","minLength":1},
            "default":{"type":"object","const":{"description":"literal data","default":"literal default"}}
        }}},
        "oneOf":[{"description":"Variant docs","type":"array","items":{"description":"Item docs","type":"string","maxLength":4}}]
    });
    remove_annotations(&mut schema);
    assert_eq!(
        schema,
        json!({
            "$defs":{"Data":{"type":"object","required":["description"],"properties":{
                "description":{"type":"string","minLength":1},
                "default":{"type":"object","const":{"description":"literal data","default":"literal default"}}
            }}},
            "oneOf":[{"type":"array","items":{"type":"string","maxLength":4}}]
        })
    );
}

#[test]
fn decoder_entry_points_are_included_in_the_retained_roots() {
    let template = include_str!("typescript_decoder.template.ts");
    for invocation in template.split("assertDefinition('").skip(1) {
        let name = invocation.split('\'').next().unwrap();
        assert!(DECODER_ROOTS.contains(&name), "missing decoder root {name}");
    }
    assert!(DECODER_ROOTS.contains(&"ClientResultSchema"));
}

#[test]
fn compact_names_preserve_entry_points_cycles_and_literal_payloads() {
    let mut schema = json!({ "$defs": {
        "Root": { "type": "object", "properties": {
            "Child": {"$ref": "#/$defs/Child"},
            "literal": {"const": {"$ref": "#/$defs/Child"}}
        }},
        "Child": {"anyOf": [{"$ref": "#/$defs/Root"}, {"type": "null"}]}
    }});
    compact_definition_names(&mut schema, &["Root"]);
    assert_eq!(
        schema,
        json!({ "$defs": {
            "Root": { "type": "object", "properties": {
                "Child": {"$ref": "#/$defs/0"},
                "literal": {"const": {"$ref": "#/$defs/Child"}}
            }},
            "0": {"anyOf": [{"$ref": "#/$defs/Root"}, {"type": "null"}]}
        }})
    );
}

#[test]
fn decoder_definitions_retain_references_and_cycles_without_following_payload_literals() {
    let mut schema = json!({ "$defs": {
        "Root": { "type": "object", "properties": {
            "value": {"$ref": "#/$defs/Child"},
            "literal": {"const": {"$ref": "#/$defs/LiteralData"}},
            "description": {"$ref": "#/$defs/Description"}
        }},
        "Child": {"anyOf": [{"$ref": "#/$defs/Root"}, {"type": "null"}]},
        "Description": {"type": "string"},
        "Unused": {"type": "integer"}
    }});
    retain_decoder_definitions(&mut schema, &["Root"]);
    assert_eq!(
        schema["$defs"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>(),
        ["Root", "Child", "Description"].into_iter().collect()
    );
    assert_eq!(
        schema["$defs"]["Root"]["properties"]["literal"]["const"],
        json!({"$ref": "#/$defs/LiteralData"})
    );
}
