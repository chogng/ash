use super::remove_annotations;
use serde_json::json;

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
