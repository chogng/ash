use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// Returns the wire contract hash used by the initialization handshake.
pub fn schema_hash() -> String {
    #[cfg(any(test, feature = "export"))]
    let schema = crate::export::protocol_schema_value();
    #[cfg(not(any(test, feature = "export")))]
    let schema = {
        let mut schema = serde_json::from_str(include_str!("../schema/json/schema.json"))
            .expect("checked-in protocol schema must be valid JSON");
        canonicalize_json(&mut schema);
        schema
    };
    let canonical =
        serde_json::to_vec(&schema).expect("canonical protocol schema must serialize as JSON");
    let digest = Sha256::digest(canonical);
    format!("sha256:{digest:x}")
}

pub(crate) fn canonicalize_json(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                canonicalize_json(value);
            }
        }
        Value::Object(object) => {
            let mut entries = std::mem::take(object).into_iter().collect::<Vec<_>>();
            for (_, value) in &mut entries {
                canonicalize_json(value);
            }
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            object.extend(entries);
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}
