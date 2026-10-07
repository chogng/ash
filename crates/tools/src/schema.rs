use crate::ToolSchemaError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

const MAX_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_SCHEMA_NODES: usize = 2_048;

/// Stable digest of a validated canonical tool schema.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ToolSchemaDigest(String);

impl ToolSchemaDigest {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolSchemaDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A bounded, validated JSON Schema accepted by Ash tool adapters.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSchema {
    canonical: Value,
    digest: ToolSchemaDigest,
}

impl ToolSchema {
    pub fn parse(value: Value) -> Result<Self, ToolSchemaError> {
        validate_schema(&value)?;
        let serialized = serde_json::to_vec(&value)
            .map_err(|error| ToolSchemaError::Serialization(error.to_string()))?;
        if serialized.len() > MAX_SCHEMA_BYTES {
            return Err(ToolSchemaError::TooLarge {
                actual: serialized.len(),
                maximum: MAX_SCHEMA_BYTES,
            });
        }

        let digest = ToolSchemaDigest(format!("{:x}", Sha256::digest(&serialized)));
        Ok(Self {
            canonical: value,
            digest,
        })
    }

    pub fn as_value(&self) -> &Value {
        &self.canonical
    }

    pub fn digest(&self) -> &ToolSchemaDigest {
        &self.digest
    }
}

/// A validated schema whose root is a JSON object suitable for function arguments.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolInputSchema(ToolSchema);

impl ToolInputSchema {
    pub fn parse(value: Value) -> Result<Self, ToolSchemaError> {
        let schema = ToolSchema::parse(value)?;
        let Value::Object(root) = schema.as_value() else {
            return Err(ToolSchemaError::InputRootMustBeObject);
        };
        if root.get("type") != Some(&Value::String("object".to_owned())) {
            return Err(ToolSchemaError::InputRootMustBeObject);
        }
        Ok(Self(schema))
    }

    pub fn as_schema(&self) -> &ToolSchema {
        &self.0
    }

    pub fn as_value(&self) -> &Value {
        self.0.as_value()
    }
}

fn validate_schema(value: &Value) -> Result<(), ToolSchemaError> {
    let mut nodes = 0;
    validate_node(value, 1, &mut nodes)
}

fn validate_node(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), ToolSchemaError> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err(ToolSchemaError::TooDeep {
            maximum: MAX_SCHEMA_DEPTH,
        });
    }
    *nodes += 1;
    if *nodes > MAX_SCHEMA_NODES {
        return Err(ToolSchemaError::TooManyNodes {
            maximum: MAX_SCHEMA_NODES,
        });
    }

    match value {
        Value::Array(values) => {
            for value in values {
                validate_node(value, depth + 1, nodes)?;
            }
        }
        Value::Object(object) => {
            if object.contains_key("$ref") {
                return Err(ToolSchemaError::UnsupportedReference);
            }
            validate_object_constraints(object)?;
            for value in object.values() {
                validate_node(value, depth + 1, nodes)?;
            }
        }
        Value::Bool(_) | Value::Null | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn validate_object_constraints(
    object: &serde_json::Map<String, Value>,
) -> Result<(), ToolSchemaError> {
    let properties = match object.get("properties") {
        Some(Value::Object(properties)) => Some(properties),
        Some(_) => return Err(ToolSchemaError::InvalidProperties),
        None => None,
    };

    let Some(required) = object.get("required") else {
        return Ok(());
    };
    let Value::Array(required) = required else {
        return Err(ToolSchemaError::InvalidRequired);
    };
    let Some(properties) = properties else {
        return Err(ToolSchemaError::InvalidRequired);
    };

    let mut seen = BTreeSet::new();
    for property in required {
        let Value::String(property) = property else {
            return Err(ToolSchemaError::InvalidRequired);
        };
        if !seen.insert(property) {
            return Err(ToolSchemaError::DuplicateRequiredProperty(property.clone()));
        }
        if !properties.contains_key(property) {
            return Err(ToolSchemaError::RequiredPropertyMissing(property.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
