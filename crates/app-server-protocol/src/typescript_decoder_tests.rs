use super::DECODER_ROOTS;
use super::compact_definition_names;
use super::deduplicate_definitions;
use super::remove_annotations;
use super::retain_decoder_definitions;
use super::schema_shards;
use super::share_inline_schemas;
use serde_json::json;

#[test]
fn schema_modules_preserve_definitions_references_and_escaped_literals_within_the_byte_budget() {
    let definitions = json!({
        "0": {"type":"object", "properties":{"child":{"$ref":"#/$defs/1"}}},
        "1": {"const":{"$ref":"literal reference", "__proto__":"literal property", "text":"quotes \" and \\ escapes"}},
        "Root": {"anyOf":[{"$ref":"#/$defs/0"},{"type":"null"}]}
    });
    let shards = schema_shards(definitions.as_object().unwrap(), 180);
    assert!(shards.len() > 1);
    let mut restored = serde_json::Map::new();
    for literal in shards {
        assert!(literal.len() <= 180);
        let json: String = serde_json::from_str(&literal).unwrap();
        let shard: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&json).unwrap();
        for (name, definition) in shard {
            assert!(restored.insert(name, definition).is_none());
        }
    }
    assert_eq!(serde_json::Value::Object(restored), definitions);
}

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
            "description":{"description":"Field docs","type":"string","minLength":1,"format":"uuid"},
            "count":{"type":"integer","minimum":0,"maximum":100,"format":"uint32"},
            "format":{"type":"string"},
            "default":{"type":"object","const":{"description":"literal data","default":"literal default","format":"literal format"}}
        }}},
        "oneOf":[{"description":"Variant docs","type":"array","items":{"description":"Item docs","type":"string","maxLength":4}}]
    });
    remove_annotations(&mut schema);
    assert_eq!(
        schema,
        json!({
            "$defs":{"Data":{"type":"object","required":["description"],"properties":{
                "description":{"type":"string","minLength":1},
                "count":{"type":"integer","minimum":0,"maximum":100},
                "format":{"type":"string"},
                "default":{"type":"object","const":{"description":"literal data","default":"literal default","format":"literal format"}}
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

#[test]
fn inline_schema_sharing_keeps_dispatch_and_literal_payloads_in_place() {
    let repeated = json!({"type":"object","additionalProperties":false,"required":["value"],"properties":{"value":{"type":"string","minLength":1,"maxLength":32768,"pattern":"^[a-z]+$"}}});
    let mut schema = json!({"$defs": {
        "Root":{"oneOf":[
            {"type":"object","properties":{"method":{"const":"first"},"result":repeated.clone()}},
            {"type":"object","properties":{"method":{"const":"second"},"result":repeated.clone()}}
        ]},
        "Literal":{"const":repeated.clone()}
    }});
    share_inline_schemas(&mut schema);
    let variants = schema["$defs"]["Root"]["oneOf"].as_array().unwrap();
    let reference = variants[0]["properties"]["result"]["$ref"]
        .as_str()
        .unwrap()
        .strip_prefix("#/$defs/")
        .unwrap();
    assert_eq!(schema["$defs"][reference], repeated);
    assert_eq!(
        variants[1]["properties"]["result"]["$ref"],
        variants[0]["properties"]["result"]["$ref"]
    );
    assert_eq!(variants[0]["properties"]["method"]["const"], "first");
    assert_eq!(schema["$defs"]["Literal"]["const"], repeated);
}
