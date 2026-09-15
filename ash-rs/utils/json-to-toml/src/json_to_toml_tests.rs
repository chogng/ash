use super::json_to_toml;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use toml::Value as TomlValue;

#[test]
fn converts_json_scalars() {
    assert_eq!(json_to_toml(json!(123)), TomlValue::Integer(123));
    assert_eq!(json_to_toml(json!(1.25)), TomlValue::Float(1.25));
    assert_eq!(json_to_toml(json!(false)), TomlValue::Boolean(false));
    assert_eq!(json_to_toml(json!("ash")), TomlValue::String("ash".into()));
}

#[test]
fn converts_json_null_to_an_empty_string() {
    assert_eq!(
        json_to_toml(JsonValue::Null),
        TomlValue::String(String::new())
    );
}

#[test]
fn recursively_converts_arrays_and_objects() {
    let json_value = json!({
        "enabled": true,
        "nested": {
            "values": [1, null, "three"]
        }
    });
    let expected = TomlValue::Table(
        [
            ("enabled".into(), TomlValue::Boolean(true)),
            (
                "nested".into(),
                TomlValue::Table(
                    [(
                        "values".into(),
                        TomlValue::Array(vec![
                            TomlValue::Integer(1),
                            TomlValue::String(String::new()),
                            TomlValue::String("three".into()),
                        ]),
                    )]
                    .into_iter()
                    .collect(),
                ),
            ),
        ]
        .into_iter()
        .collect(),
    );

    assert_eq!(json_to_toml(json_value), expected);
}

#[test]
fn converts_unsigned_values_outside_the_toml_integer_range_to_floats() {
    let json_value = json!(u64::MAX);

    assert_eq!(json_to_toml(json_value), TomlValue::Float(u64::MAX as f64));
}
