use crate::ConfigError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Stable, namespaced identity for one logical MCP server declaration.
///
/// The containing configuration authority validates the namespace it owns. This keeps User,
/// Directory, and Plugin declarations from silently colliding on a display name.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct McpServerId(String);

impl McpServerId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConfigError> {
        let value = value.into();
        if !is_namespaced_mcp_id(&value) {
            return Err(ConfigError(
                "MCP server id must use '<namespace>:mcp:<local-id>' form".into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn belongs_to_namespace(&self, namespace: &str) -> bool {
        self.0
            .strip_prefix(namespace)
            .is_some_and(|suffix| suffix.starts_with(":mcp:"))
    }
}

impl std::fmt::Display for McpServerId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for McpServerId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A non-secret reference to credential material owned by the relevant authentication domain.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum McpCredentialBinding {
    #[default]
    Unauthenticated,
    Reference {
        credential_ref: String,
    },
}

/// Desired enablement for a configured MCP server.
///
/// This is user intent only. An enabled declaration still needs runtime policy, credential, and
/// transport checks before an MCP manager may connect it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum McpServerEnablement {
    #[default]
    Disabled,
    Enabled,
}

/// Non-secret transport declaration for one standalone MCP server.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum McpTransportConfig {
    Stdio { command: String, args: Vec<String> },
    StreamableHttp { url: String },
}

/// Desired, runtime-free definition for a standalone MCP server.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerConfig {
    pub id: McpServerId,
    pub display_name: String,
    pub transport: McpTransportConfig,
    #[serde(default)]
    pub credential: McpCredentialBinding,
    #[serde(default)]
    pub enablement: McpServerEnablement,
}

impl McpServerConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        validate_text(&self.display_name, "MCP server display name")?;
        self.transport.validate()?;
        if let McpCredentialBinding::Reference { credential_ref } = &self.credential {
            validate_text(credential_ref, "MCP credential reference")?;
        }
        Ok(())
    }
}

/// MCP declarations owned by the user configuration authority.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: BTreeMap<McpServerId, McpServerConfig>,
}

impl McpConfig {
    pub(crate) fn validate_for_namespace(&self, namespace: &str) -> Result<(), ConfigError> {
        for (server_id, server) in &self.servers {
            if &server.id != server_id {
                return Err(ConfigError(format!(
                    "MCP server entry '{}' contains declaration for '{}'",
                    server_id, server.id
                )));
            }
            if !server_id.belongs_to_namespace(namespace) {
                return Err(ConfigError(format!(
                    "MCP server '{}' is outside the '{namespace}' namespace",
                    server_id
                )));
            }
            server.validate()?;
        }
        Ok(())
    }
}

impl McpTransportConfig {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        match self {
            Self::Stdio { command, args } => {
                validate_text(command, "MCP stdio command")?;
                for argument in args {
                    validate_text(argument, "MCP stdio argument")?;
                }
            }
            Self::StreamableHttp { url } => {
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(ConfigError(
                        "MCP Streamable HTTP URL must use http or https".into(),
                    ));
                }
                validate_text(url, "MCP Streamable HTTP URL")?;
            }
        }
        Ok(())
    }
}

fn is_namespaced_mcp_id(value: &str) -> bool {
    let Some((namespace, local_id)) = value.split_once(":mcp:") else {
        return false;
    };
    !namespace.trim().is_empty()
        && !local_id.trim().is_empty()
        && !namespace.contains(char::is_whitespace)
        && !local_id.contains(':')
        && !local_id.contains(char::is_whitespace)
        && !value.contains('\0')
}

fn validate_text(value: &str, label: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() || value.contains('\0') || value.contains(['\n', '\r']) {
        return Err(ConfigError(format!("{label} must be non-empty plain text")));
    }
    Ok(())
}
