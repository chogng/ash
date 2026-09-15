use serde::Deserializer;
use serde::de::DeserializeSeed;
use serde::de::EnumAccess;
use serde::de::MapAccess;
use serde::de::SeqAccess;
use serde::de::VariantAccess;
use serde::de::Visitor;
use std::collections::BTreeMap;
use std::fmt;

use crate::AgentImportDiagnosticCode;
use crate::source::MAX_DOCUMENT_DEPTH;
use crate::source::MAX_DOCUMENT_NODES;
use crate::source::MAX_FILE_BYTES;
use serde_yaml::Value as YamlValue;

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
    let parsed: YamlValue = match serde_yaml::from_str(raw_frontmatter) {
        Ok(parsed) => parsed,
        Err(_) => {
            return (
                BTreeMap::new(),
                Some(AgentImportDiagnosticCode::InvalidContent),
            );
        }
    };
    let Some(mapping) = parsed.as_mapping() else {
        return (
            BTreeMap::new(),
            Some(AgentImportDiagnosticCode::InvalidContent),
        );
    };

    let mut frontmatter = BTreeMap::new();
    for (key, value) in mapping {
        let Some(key) = key.as_str().map(str::trim).filter(|key| !key.is_empty()) else {
            continue;
        };
        frontmatter.insert(key.to_string(), frontmatter_value_from_yaml(value));
    }

    (frontmatter, None)
}

fn frontmatter_value_from_yaml(value: &YamlValue) -> FrontmatterValue {
    match value {
        YamlValue::String(value) => FrontmatterValue::Scalar(value.trim().to_string()),
        YamlValue::Bool(value) => FrontmatterValue::Scalar(value.to_string()),
        YamlValue::Number(value) => FrontmatterValue::Scalar(value.to_string()),
        YamlValue::Null | YamlValue::Sequence(_) | YamlValue::Mapping(_) | YamlValue::Tagged(_) => {
            FrontmatterValue::Other
        }
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

// Check expanded YAML before constructing Value: aliases can duplicate scalars and subtrees
// without increasing file size. The seed walks the same deserializer without allocating a tree.
fn validate_yaml(raw: &str) -> Result<(), AgentImportDiagnosticCode> {
    let mut budget = YamlBudget {
        nodes: 0,
        bytes: 0,
        exceeded: false,
    };
    let result = BoundedYaml {
        budget: &mut budget,
        depth: 0,
    }
    .deserialize(serde_yaml::Deserializer::from_str(raw));
    result.map_err(|_| {
        if budget.exceeded {
            AgentImportDiagnosticCode::LimitExceeded
        } else {
            AgentImportDiagnosticCode::InvalidContent
        }
    })
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
pub(crate) fn instruction_header(
    content: &str,
) -> Result<(YamlValue, String), AgentImportDiagnosticCode> {
    let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return Ok((YamlValue::Mapping(Default::default()), content.into()));
    };
    let (end, body_start) =
        frontmatter_end(rest).ok_or(AgentImportDiagnosticCode::InvalidContent)?;
    let raw = &rest[..end];
    validate_yaml(raw)?;
    let header: YamlValue =
        serde_yaml::from_str(raw).map_err(|_| AgentImportDiagnosticCode::InvalidContent)?;
    if !header.is_mapping() {
        return Err(AgentImportDiagnosticCode::InvalidContent);
    }
    Ok((header, rest[body_start..].into()))
}
