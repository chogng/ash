use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::path::{Component, Path, PathBuf};

const MAX_PLUGIN_PATH_BYTES: usize = 1024;
const MAX_PLUGIN_PATH_SEGMENT_BYTES: usize = 255;
pub(crate) const MAX_PLUGIN_PATH_DEPTH: usize = 32;

/// Canonical slash-separated path relative to a Plugin package root.
///
/// V1 paths deliberately use a portable ASCII subset. This prevents platform separator, device
/// name, and Unicode-normalization ambiguity before a path reaches the filesystem.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PluginPath(String);

impl PluginPath {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidPluginPath> {
        let value = value.into();
        if value.is_empty() {
            return Err(InvalidPluginPath::Empty);
        }
        if value.len() > MAX_PLUGIN_PATH_BYTES {
            return Err(InvalidPluginPath::TooLong);
        }
        if value.starts_with('/') || value.starts_with('\\') || value.contains('\\') {
            return Err(InvalidPluginPath::NotRelativeSlashSeparated);
        }
        let segments: Vec<_> = value.split('/').collect();
        if segments.len() > MAX_PLUGIN_PATH_DEPTH {
            return Err(InvalidPluginPath::TooDeep);
        }
        for segment in segments {
            validate_segment(segment)?;
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn from_relative_path(path: &Path) -> Result<Self, InvalidPluginPath> {
        let mut segments = Vec::new();
        for component in path.components() {
            let Component::Normal(segment) = component else {
                return Err(InvalidPluginPath::NotRelativeSlashSeparated);
            };
            let Some(segment) = segment.to_str() else {
                return Err(InvalidPluginPath::UnsupportedCharacter);
            };
            segments.push(segment);
        }
        Self::new(segments.join("/"))
    }

    pub fn to_platform_path(&self) -> PathBuf {
        self.0.split('/').collect()
    }
}

impl fmt::Display for PluginPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for PluginPath {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PluginPath {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Reason a package-relative path was rejected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidPluginPath {
    Empty,
    TooLong,
    TooDeep,
    EmptySegment,
    DotSegment,
    NotRelativeSlashSeparated,
    UnsupportedCharacter,
    SegmentTooLong,
    PlatformDeviceName,
}

impl fmt::Display for InvalidPluginPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("plugin path must not be empty"),
            Self::TooLong => write!(
                formatter,
                "plugin path exceeds the {MAX_PLUGIN_PATH_BYTES}-byte limit"
            ),
            Self::TooDeep => write!(
                formatter,
                "plugin path exceeds the {MAX_PLUGIN_PATH_DEPTH}-segment depth limit"
            ),
            Self::EmptySegment => formatter.write_str("plugin path contains an empty segment"),
            Self::DotSegment => {
                formatter.write_str("plugin path must not contain '.' or '..' segments")
            }
            Self::NotRelativeSlashSeparated => {
                formatter.write_str("plugin path must be relative and slash-separated")
            }
            Self::UnsupportedCharacter => formatter.write_str(
                "plugin path segments may contain only ASCII letters, digits, '.', '_', and '-'",
            ),
            Self::SegmentTooLong => write!(
                formatter,
                "plugin path segment exceeds the {MAX_PLUGIN_PATH_SEGMENT_BYTES}-byte limit"
            ),
            Self::PlatformDeviceName => {
                formatter.write_str("plugin path contains a reserved platform device name")
            }
        }
    }
}

impl std::error::Error for InvalidPluginPath {}

fn validate_segment(segment: &str) -> Result<(), InvalidPluginPath> {
    if segment.is_empty() {
        return Err(InvalidPluginPath::EmptySegment);
    }
    if matches!(segment, "." | "..") {
        return Err(InvalidPluginPath::DotSegment);
    }
    if segment.len() > MAX_PLUGIN_PATH_SEGMENT_BYTES {
        return Err(InvalidPluginPath::SegmentTooLong);
    }
    if !segment
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(InvalidPluginPath::UnsupportedCharacter);
    }
    let base_name = segment.split('.').next().unwrap_or(segment);
    if is_windows_device_name(base_name) {
        return Err(InvalidPluginPath::PlatformDeviceName);
    }
    Ok(())
}

fn is_windows_device_name(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    matches!(value.as_str(), "con" | "prn" | "aux" | "nul")
        || value
            .strip_prefix("com")
            .or_else(|| value.strip_prefix("lpt"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

#[cfg(test)]
#[path = "path_tests.rs"]
mod tests;
