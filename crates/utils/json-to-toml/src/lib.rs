//! Deterministic conversion from JSON values to TOML values.

use serde_json::Value as JsonValue;
use toml::Value as TomlValue;

/// Converts an owned JSON value into the corresponding TOML value.
///
/// JSON null has no TOML equivalent and becomes an empty string. Numbers prefer an exact signed
/// integer, then a floating-point value, and finally their decimal string representation.
pub fn json_to_toml(value: JsonValue) -> TomlValue {
    match value {
        JsonValue::Null => TomlValue::String(String::new()),
        JsonValue::Bool(value) => TomlValue::Boolean(value),
        JsonValue::Number(value) => {
            if let Some(integer) = value.as_i64() {
                TomlValue::Integer(integer)
            } else if let Some(float) = value.as_f64() {
                TomlValue::Float(float)
            } else {
                TomlValue::String(value.to_string())
            }
        }
        JsonValue::String(value) => TomlValue::String(value),
        JsonValue::Array(values) => {
            TomlValue::Array(values.into_iter().map(json_to_toml).collect())
        }
        JsonValue::Object(values) => TomlValue::Table(
            values
                .into_iter()
                .map(|(key, value)| (key, json_to_toml(value)))
                .collect(),
        ),
    }
}

#[cfg(test)]
#[path = "json_to_toml_tests.rs"]
mod tests;
