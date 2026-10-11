use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use std::fmt;

const MAX_SEGMENT_BYTES: usize = 128;
// Leave room for contribution names in the 256-byte runtime IDs and fit the 160-byte
// declarative Extension identity formed from these same source and plugin components.
const MAX_PLUGIN_ID_BYTES: usize = 160;

/// Configured source identity, independent of its transport and publishers.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ExtensionSourceId(String);

impl ExtensionSourceId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidPluginId> {
        let value = value.into();
        if !valid_segment(&value, Segment::Extensions) {
            return Err(InvalidPluginId::Extensions);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ExtensionSourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExtensionSourceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Stable, source-qualified plugin identity: `name@source_id`.
///
/// Names are independent of publisher conventions. Source providers own their package-format
/// mapping and trust checks; this type only validates identity and safe path segments.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PluginId {
    plugin_name: String,
    source_id: ExtensionSourceId,
}

impl PluginId {
    pub fn new(
        plugin_name: impl Into<String>,
        source_id: ExtensionSourceId,
    ) -> Result<Self, InvalidPluginId> {
        let plugin_name = plugin_name.into();
        if !valid_segment(&plugin_name, Segment::Plugin) {
            return Err(InvalidPluginId::Name);
        }
        if plugin_name.len() + 1 + source_id.as_str().len() > MAX_PLUGIN_ID_BYTES {
            return Err(InvalidPluginId::TooLong);
        }
        Ok(Self {
            plugin_name,
            source_id,
        })
    }

    pub fn parse(value: &str) -> Result<Self, InvalidPluginId> {
        let (plugin, source_id) = value.rsplit_once('@').ok_or(InvalidPluginId::Shape)?;
        Self::new(plugin, ExtensionSourceId::new(source_id)?)
    }

    pub fn plugin_name(&self) -> &str {
        &self.plugin_name
    }
    pub fn source_id(&self) -> &ExtensionSourceId {
        &self.source_id
    }
}

impl fmt::Display for PluginId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}@{}", self.plugin_name, self.source_id)
    }
}

impl Serialize for PluginId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for PluginId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Invalid plugin identity or configured source_id name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidPluginId {
    Shape,
    Name,
    Extensions,
    TooLong,
}

impl fmt::Display for InvalidPluginId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Shape => "plugin id must use '<name>@<source_id>'",
            Self::Name => "plugin name must use at most 128 ASCII letters, digits, '_', '-' or dots between non-empty segments",
            Self::Extensions => "source_id name must use 1–128 ASCII letters, digits, '_' or '-'",
            Self::TooLong => "plugin id including source_id must not exceed 160 bytes",
        })
    }
}

impl std::error::Error for InvalidPluginId {}

enum Segment {
    Plugin,
    Extensions,
}

fn valid_segment(value: &str, segment: Segment) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SEGMENT_BYTES
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_')
                || matches!(segment, Segment::Plugin) && byte == b'.'
        })
}

#[cfg(test)]
#[path = "plugin_id_tests.rs"]
mod tests;
