use serde::Deserialize;
use serde::Deserializer;
use serde::de::DeserializeOwned;
use serde::de::DeserializeSeed;
use serde::de::EnumAccess;
use serde::de::IgnoredAny;
use serde::de::MapAccess;
use serde::de::SeqAccess;
use serde::de::VariantAccess;
use serde::de::Visitor;
use serde::de::value::MapAccessDeserializer;
use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;

use crate::AgentImportDiagnosticCode;
use crate::source::MAX_DOCUMENT_DEPTH;
use crate::source::MAX_DOCUMENT_NODES;
use crate::source::MAX_FILE_BYTES;

/// One markdown document split into its frontmatter mapping and body.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct FrontmatterDocument {
    pub(crate) frontmatter: BTreeMap<String, FrontmatterValue>,
    pub(crate) body: String,
    frontmatter_error: Option<AgentImportDiagnosticCode>,
}

/// One frontmatter value reduced to the scalar strings external layouts rely on.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum FrontmatterValue {
    Scalar(String),
    Other,
}

impl FrontmatterValue {
    pub(crate) fn as_scalar(&self) -> Option<&str> {
        match self {
            Self::Scalar(value) => Some(value),
            Self::Other => None,
        }
    }
}

pub(crate) fn parse_frontmatter_document(content: &str) -> FrontmatterDocument {
    let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return FrontmatterDocument {
            frontmatter: BTreeMap::new(),
            body: content.to_string(),
            frontmatter_error: None,
        };
    };
    let Some((end, body_start)) = frontmatter_end(rest) else {
        return FrontmatterDocument {
            frontmatter: BTreeMap::new(),
            body: content.to_string(),
            frontmatter_error: None,
        };
    };

    let raw_frontmatter = &rest[..end];
    let body = &rest[body_start..];
    let (frontmatter, frontmatter_error) = parse_frontmatter(raw_frontmatter);
    FrontmatterDocument {
        frontmatter,
        body: body.to_string(),
        frontmatter_error,
    }
}

fn frontmatter_end(rest: &str) -> Option<(usize, usize)> {
    [
        "\r\n---\r\n",
        "\r\n---\n",
        "\n---\r\n",
        "\n---\n",
        "\r\n---",
        "\n---",
    ]
    .into_iter()
    .filter_map(|delimiter| rest.find(delimiter).map(|end| (end, end + delimiter.len())))
    .min_by_key(|(end, _body_start)| *end)
}

fn parse_frontmatter(
    raw_frontmatter: &str,
) -> (
    BTreeMap<String, FrontmatterValue>,
    Option<AgentImportDiagnosticCode>,
) {
    if let Err(code) = validate_yaml(raw_frontmatter) {
        return (BTreeMap::new(), Some(code));
    }
    match serde_saphyr::from_str::<FrontmatterMapping>(raw_frontmatter) {
        Ok(mapping) => (mapping.0, None),
        Err(_) => (
            BTreeMap::new(),
            Some(AgentImportDiagnosticCode::InvalidContent),
        ),
    }
}

// Importers only consume top-level scalar fields. Drain compound values without building
// a second YAML tree, while retaining the distinction between string and non-string keys.
struct FrontmatterMapping(BTreeMap<String, FrontmatterValue>);

enum ScalarField {
    Text(String),
    NumberOrBool(String),
    Other,
}

impl<'de> Deserialize<'de> for ScalarField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ScalarFieldVisitor)
    }
}

struct ScalarFieldVisitor;

impl<'de> Visitor<'de> for ScalarFieldVisitor {
    type Value = ScalarField;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a frontmatter field")
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(ScalarField::Text(value.trim().into()))
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(ScalarField::NumberOrBool(value.to_string()))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(ScalarField::NumberOrBool(value.to_string()))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(ScalarField::NumberOrBool(value.to_string()))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
        let value = if value.is_nan() {
            ".nan".into()
        } else if value == f64::INFINITY {
            ".inf".into()
        } else if value == f64::NEG_INFINITY {
            "-.inf".into()
        } else {
            format!("{value:?}")
        };
        Ok(ScalarField::NumberOrBool(value))
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(ScalarField::Other)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(ScalarField::Other)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(ScalarField::Other)
    }
}

impl<'de> Deserialize<'de> for FrontmatterMapping {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(FrontmatterMappingVisitor)
    }
}

struct FrontmatterMappingVisitor;

impl<'de> Visitor<'de> for FrontmatterMappingVisitor {
    type Value = FrontmatterMapping;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a frontmatter mapping")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = BTreeMap::new();
        while let Some((key, value)) = map
            .next_entry::<serde_saphyr::Tagged<ScalarField>, serde_saphyr::Tagged<ScalarField>>()?
        {
            if let serde_saphyr::Tagged(ScalarField::Text(key), None) = key {
                if key.is_empty() {
                    continue;
                }
                let value = match value {
                    serde_saphyr::Tagged(
                        ScalarField::Text(value) | ScalarField::NumberOrBool(value),
                        None,
                    ) => FrontmatterValue::Scalar(value),
                    _ => FrontmatterValue::Other,
                };
                fields.insert(key, value);
            }
        }
        Ok(FrontmatterMapping(fields))
    }
}

pub(crate) fn frontmatter_scalar(
    frontmatter: &BTreeMap<String, FrontmatterValue>,
    key: &str,
) -> Option<String> {
    frontmatter
        .get(key)
        .and_then(FrontmatterValue::as_scalar)
        .map(ToOwned::to_owned)
}

pub(crate) fn frontmatter_error(
    document: &FrontmatterDocument,
) -> Option<AgentImportDiagnosticCode> {
    document.frontmatter_error
}

// Check expanded YAML before typed decoding: aliases can duplicate scalars and subtrees
// without increasing file size. The seed visits every field without allocating a tree.
fn validate_yaml(raw: &str) -> Result<(), AgentImportDiagnosticCode> {
    let mut budget = YamlBudget {
        nodes: 0,
        bytes: 0,
        exceeded: false,
    };
    let result = serde_saphyr::with_deserializer_from_str(raw, |deserializer| {
        BoundedYaml {
            budget: &mut budget,
            depth: 0,
        }
        .deserialize(deserializer)
    });
    result.map_err(|error| {
        if budget.exceeded || yaml_limit_error(&error) {
            AgentImportDiagnosticCode::LimitExceeded
        } else {
            AgentImportDiagnosticCode::InvalidContent
        }
    })
}

// The parser can reject nesting or alias replay before our visitor reaches its own limit.
// Preserve the import diagnostic even when the library supplies the earlier guard.
fn yaml_limit_error(error: &serde_saphyr::Error) -> bool {
    use serde_saphyr::Error;
    match error.without_snippet() {
        Error::Budget { .. }
        | Error::AliasReplayCounterOverflow { .. }
        | Error::AliasReplayLimitExceeded { .. }
        | Error::AliasExpansionLimitExceeded { .. }
        | Error::AliasReplayStackDepthExceeded { .. } => true,
        Error::AliasError { error, .. } => yaml_limit_error(error),
        _ => false,
    }
}

struct YamlBudget {
    nodes: usize,
    bytes: usize,
    exceeded: bool,
}

impl YamlBudget {
    fn limit<E: serde::de::Error>(&mut self) -> E {
        self.exceeded = true;
        E::custom("frontmatter resource limit exceeded")
    }
}

struct BoundedYaml<'a> {
    budget: &'a mut YamlBudget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for BoundedYaml<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        self.budget.nodes += 1;
        if self.depth > MAX_DOCUMENT_DEPTH || self.budget.nodes > MAX_DOCUMENT_NODES {
            return Err(self.budget.limit());
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for BoundedYaml<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded YAML value")
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_bool<E: serde::de::Error>(self, _value: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E: serde::de::Error>(self, _value: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E: serde::de::Error>(self, _value: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<(), E> {
        Ok(())
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<(), E> {
        self.budget.bytes = self.budget.bytes.saturating_add(value.len());
        if self.budget.bytes > MAX_FILE_BYTES {
            return Err(self.budget.limit());
        }
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
        while sequence
            .next_element_seed(BoundedYaml {
                budget: &mut *self.budget,
                depth: self.depth + 1,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while map
            .next_key_seed(BoundedYaml {
                budget: &mut *self.budget,
                depth: self.depth + 1,
            })?
            .is_some()
        {
            map.next_value_seed(BoundedYaml {
                budget: &mut *self.budget,
                depth: self.depth + 1,
            })?;
        }
        Ok(())
    }

    fn visit_enum<A: EnumAccess<'de>>(self, data: A) -> Result<(), A::Error> {
        let (_, variant) = data.variant_seed(BoundedYaml {
            budget: &mut *self.budget,
            depth: self.depth + 1,
        })?;
        variant.newtype_variant_seed(BoundedYaml {
            budget: self.budget,
            depth: self.depth + 1,
        })
    }
}

#[cfg(test)]
#[path = "frontmatter_tests.rs"]
mod tests;

/// Strict, bounded header parsing for instruction source formats.
pub(crate) fn instruction_header<T: DeserializeOwned>(
    content: &str,
) -> Result<(T, String), AgentImportDiagnosticCode> {
    let (raw, body) = if let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    {
        let (end, body_start) =
            frontmatter_end(rest).ok_or(AgentImportDiagnosticCode::InvalidContent)?;
        (&rest[..end], &rest[body_start..])
    } else {
        ("{}", content)
    };
    validate_yaml(raw)?;
    let header = serde_saphyr::with_deserializer_from_str(raw, |deserializer| {
        deserializer.deserialize_map(InstructionHeaderVisitor::<T>(PhantomData))
    })
    .map_err(|_| AgentImportDiagnosticCode::InvalidContent)?;
    Ok((header, body.into()))
}

// Serde structs also accept positional sequences. External instruction headers require a
// mapping, so enforce that shape before handing the fields to the format's typed contract.
struct InstructionHeaderVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for InstructionHeaderVisitor<T> {
    type Value = T;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an instruction header mapping")
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<T, A::Error> {
        T::deserialize(MapAccessDeserializer::new(map))
    }
}
