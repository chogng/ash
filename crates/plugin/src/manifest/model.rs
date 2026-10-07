use crate::{PluginError, PluginErrorKind, PluginPackageId, PluginPath, PluginVersion};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use super::MAX_MANIFEST_BYTES;
use super::editor_extension::EditorExtensionContribution;

const MAX_LOCAL_ID_BYTES: usize = 64;

/// Strictly parsed v1 Plugin manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub schema_version: u32,
    pub id: PluginPackageId,
    pub version: PluginVersion,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub compatibility: PluginCompatibility,
    #[serde(default)]
    pub contributions: PluginContributions,
    #[serde(default)]
    pub permissions: Vec<Permission>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credential_slots: Vec<CredentialSlot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
}

impl<'de> Deserialize<'de> for PluginManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let unchecked = UncheckedPluginManifest::deserialize(deserializer)?;
        let manifest = Self {
            schema_version: unchecked.schema_version,
            id: unchecked.id,
            version: unchecked.version,
            display_name: unchecked.display_name,
            description: unchecked.description,
            license: unchecked.license,
            compatibility: unchecked.compatibility,
            contributions: unchecked.contributions,
            permissions: unchecked.permissions,
            credential_slots: unchecked.credential_slots,
            metadata: unchecked.metadata,
        };
        manifest.validate().map_err(serde::de::Error::custom)?;
        Ok(manifest)
    }
}

impl PluginManifest {
    /// Strict-parses and semantically validates one v1 manifest.
    pub fn from_json(bytes: &[u8]) -> Result<Self, PluginError> {
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(PluginError::new(
                PluginErrorKind::ManifestInvalid,
                "plugin manifest exceeds the 1 MiB size limit",
            ));
        }
        serde_json::from_slice(bytes).map_err(|error| {
            PluginError::new(
                PluginErrorKind::ManifestInvalid,
                format!("plugin manifest is not valid strict JSON: {error}"),
            )
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UncheckedPluginManifest {
    schema_version: u32,
    id: PluginPackageId,
    version: PluginVersion,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    license: Option<String>,
    compatibility: PluginCompatibility,
    #[serde(default)]
    contributions: PluginContributions,
    #[serde(default)]
    permissions: Vec<Permission>,
    #[serde(default)]
    credential_slots: Vec<CredentialSlot>,
    #[serde(default)]
    metadata: BTreeMap<String, Value>,
}

/// Ash release compatibility declared by a Plugin.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCompatibility {
    pub ash: AshVersionRequirement,
}

/// Semantic-version requirement for the Ash host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AshVersionRequirement(semver::VersionReq);

impl AshVersionRequirement {
    pub fn new(value: impl AsRef<str>) -> Result<Self, InvalidVersionRequirement> {
        semver::VersionReq::parse(value.as_ref())
            .map(Self)
            .map_err(|_| InvalidVersionRequirement)
    }

    pub fn matches(&self, version: &semver::Version) -> bool {
        self.0.matches(version)
    }
}

impl fmt::Display for AshVersionRequirement {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for AshVersionRequirement {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for AshVersionRequirement {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// An invalid Ash semantic-version requirement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidVersionRequirement;

impl fmt::Display for InvalidVersionRequirement {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("compatibility.ash must be a valid semantic-version requirement")
    }
}

impl std::error::Error for InvalidVersionRequirement {}

/// Stable manifest-local identity used by a contribution or credential slot.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ManifestLocalId(String);

impl ManifestLocalId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidManifestLocalId> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_LOCAL_ID_BYTES || !is_local_id(&value) {
            return Err(InvalidManifestLocalId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ManifestLocalId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for ManifestLocalId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ManifestLocalId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A manifest-local ID outside the canonical lowercase kebab-case shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidManifestLocalId;

impl fmt::Display for InvalidManifestLocalId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "manifest-local id must be 1-{MAX_LOCAL_ID_BYTES} bytes of lowercase ASCII letters, \
             digits, or single hyphens"
        )
    }
}

impl std::error::Error for InvalidManifestLocalId {}

/// Declarative contributions contained in one Plugin package.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginContributions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServerContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connectors: Vec<ConnectorContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<AssetContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub editor_extensions: Vec<EditorExtensionContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub declarative_extensions: Vec<DeclarativeExtensionContribution>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillContribution {
    pub id: ManifestLocalId,
    pub path: PluginPath,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerContribution {
    pub id: ManifestLocalId,
    pub definition: PluginPath,
}

/// User-connectable external product surface backed by one MCP contribution in this package.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorContribution {
    pub id: ManifestLocalId,
    pub display_name: String,
    pub description: String,
    pub mcp_server: ManifestLocalId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetContribution {
    pub id: ManifestLocalId,
    pub path: PluginPath,
}

/// One static Editor Extension package activated through Plugin authority.
///
/// The directory must contain a declarative `package.json`. The `ash-extension-catalog` crate owns
/// parsing that package and freezing its resources; this declaration does not grant code
/// execution or reinterpret executable `editorExtensions[]` contributions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclarativeExtensionContribution {
    pub id: ManifestLocalId,
    pub path: PluginPath,
}

/// Maximum activation capability requested by a Plugin package.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Permission {
    Process { executable: PluginPath },
    Directory { access: DirectoryAccess },
    Network { hosts: Vec<NetworkHost> },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryAccess {
    Read,
    Write,
}

/// Exact network host requested by a Plugin.
///
/// V1 deliberately rejects schemes, ports, and wildcard patterns. Runtime network policy remains
/// responsible for resolving and enforcing this declarative maximum.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NetworkHost(String);

impl NetworkHost {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidNetworkHost> {
        let value = value.into();
        if !is_network_host(&value) {
            return Err(InvalidNetworkHost);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NetworkHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for NetworkHost {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for NetworkHost {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidNetworkHost;

impl fmt::Display for InvalidNetworkHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("network host must be an exact lowercase DNS name or IP address")
    }
}

impl std::error::Error for InvalidNetworkHost {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialSlot {
    pub name: ManifestLocalId,
    pub kind: CredentialKind,
    #[serde(default)]
    pub required_for: Vec<ContributionReference>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    SecretText,
}

/// Kind portion of a stable manifest-local contribution reference.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ContributionKind {
    Skill,
    Mcp,
    Connector,
    Asset,
    EditorExtension,
}

impl ContributionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Mcp => "mcp",
            Self::Connector => "connector",
            Self::Asset => "asset",
            Self::EditorExtension => "editorExtension",
        }
    }
}

/// Stable `<kind>:<manifest-local-id>` reference used by credential requirements.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ContributionReference {
    pub kind: ContributionKind,
    pub id: ManifestLocalId,
}

impl fmt::Display for ContributionReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.kind.as_str(), self.id)
    }
}

impl FromStr for ContributionReference {
    type Err = InvalidContributionReference;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some((kind, id)) = value.split_once(':') else {
            return Err(InvalidContributionReference);
        };
        if value.matches(':').count() != 1 {
            return Err(InvalidContributionReference);
        }
        let kind = match kind {
            "skill" => ContributionKind::Skill,
            "mcp" => ContributionKind::Mcp,
            "connector" => ContributionKind::Connector,
            "asset" => ContributionKind::Asset,
            "editorExtension" => ContributionKind::EditorExtension,
            _ => return Err(InvalidContributionReference),
        };
        let id = ManifestLocalId::new(id).map_err(|_| InvalidContributionReference)?;
        Ok(Self { kind, id })
    }
}

impl Serialize for ContributionReference {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ContributionReference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidContributionReference;

impl fmt::Display for InvalidContributionReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "contribution reference must use 'skill:<id>', 'mcp:<id>', 'connector:<id>', 'asset:<id>', or 'editorExtension:<id>'",
        )
    }
}

impl std::error::Error for InvalidContributionReference {}

fn is_local_id(value: &str) -> bool {
    !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn is_network_host(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 || value != value.to_ascii_lowercase() {
        return false;
    }
    if value.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}
