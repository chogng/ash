use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use std::fmt;

const MAX_PLUGIN_ID_BYTES: usize = 128;

/// Publisher-owned identity declared by the `.ash-plugin` package format.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PluginPackageId(String);

impl PluginPackageId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidPluginPackageId> {
        let value = value.into();
        if value.len() > MAX_PLUGIN_ID_BYTES {
            return Err(InvalidPluginPackageId::TooLong);
        }
        let Some((publisher, name)) = value.split_once('/') else {
            return Err(InvalidPluginPackageId::InvalidShape);
        };
        if value.matches('/').count() != 1
            || !is_plugin_id_segment(publisher)
            || !is_plugin_id_segment(name)
        {
            return Err(InvalidPluginPackageId::InvalidShape);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the publisher namespace carried by this validated Plugin identity.
    pub fn publisher(&self) -> &str {
        self.0
            .split_once('/')
            .expect("validated Plugin identity contains one separator")
            .0
    }
}

impl fmt::Display for PluginPackageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for PluginPackageId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PluginPackageId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Reason a `.ash-plugin` package identity was rejected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidPluginPackageId {
    TooLong,
    InvalidShape,
}

impl fmt::Display for InvalidPluginPackageId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong => write!(
                formatter,
                "plugin package id exceeds the {MAX_PLUGIN_ID_BYTES}-byte limit"
            ),
            Self::InvalidShape => formatter.write_str(
                "plugin package id must use '<publisher>/<name>' with lowercase ASCII letters, digits, \
                 and single hyphens",
            ),
        }
    }
}

impl std::error::Error for InvalidPluginPackageId {}

fn is_plugin_id_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
