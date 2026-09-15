use crate::DirExecPolicyConfig;
use crate::{
    ConfigError, DirPluginRequests, HooksConfig, McpServerEnablement, McpServerId,
    McpTransportConfig, SkillSourceConfig, SkillSourceId,
};
use ash_file_access::DirId;
use ash_protocol::ModelRef;
use ash_protocol::ReasoningEffort;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Scope supplied by the host when it reads one directory configuration document.
///
/// The identity is deliberately outside the document: a checked-out file must not choose the
/// namespace in which its MCP or Skill declarations will be interpreted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirConfigScope {
    pub dir_id: DirId,
}

impl DirConfigScope {
    pub fn new(dir_id: DirId) -> Self {
        Self { dir_id }
    }

    fn namespace(&self) -> String {
        format!("dir:{}", self.dir_id.as_str())
    }
}

/// Revision assigned by the host to one observed directory configuration document.
///
/// The document itself cannot author this revision. Hosts typically advance it after observing a
/// validated content change, which prevents checked-out dir files from controlling runtime
/// generation semantics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct DirConfigRevision(u64);

impl DirConfigRevision {
    pub const INITIAL: Self = Self(0);

    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }

    /// Advances a host-observed directory content revision.
    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

/// Agent defaults requested by a directory configuration document.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirAgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
}

/// Runtime-free MCP declaration requested by a directory.
///
/// It intentionally omits credential binding. A directory can request an unauthenticated server,
/// but cannot select a credential or grant itself access to one.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirMcpServerConfig {
    pub id: McpServerId,
    pub display_name: String,
    pub transport: McpTransportConfig,
    #[serde(default)]
    pub enablement: McpServerEnablement,
}

impl DirMcpServerConfig {
    fn validate(&self, namespace: &str) -> Result<(), ConfigError> {
        if !self.id.belongs_to_namespace(namespace) {
            return Err(ConfigError(format!(
                "directory MCP server '{}' is outside the '{namespace}' namespace",
                self.id
            )));
        }
        validate_text(&self.display_name, "directory MCP server display name")?;
        self.transport.validate()
    }
}

/// Directory-provided MCP declarations. They are desired configuration, not live connections.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirMcpConfig {
    #[serde(default)]
    pub servers: BTreeMap<McpServerId, DirMcpServerConfig>,
}

impl DirMcpConfig {
    fn validate(&self, namespace: &str) -> Result<(), ConfigError> {
        for (server_id, server) in &self.servers {
            if &server.id != server_id {
                return Err(ConfigError(format!(
                    "directory MCP entry '{}' contains declaration for '{}'",
                    server_id, server.id
                )));
            }
            server.validate(namespace)?;
        }
        Ok(())
    }
}

/// Directory Skill sources. Each source remains an opaque reference until a Skill manager checks
/// containment and the `DiscoverSkills` capability.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirSkillsConfig {
    #[serde(default)]
    pub sources: BTreeMap<SkillSourceId, SkillSourceConfig>,
}

impl DirSkillsConfig {
    fn validate(&self, namespace: &str) -> Result<(), ConfigError> {
        for (source_id, source) in &self.sources {
            if &source.id != source_id {
                return Err(ConfigError(format!(
                    "directory Skill entry '{}' contains declaration for '{}'",
                    source_id, source.id
                )));
            }
            if !source_id.belongs_to_namespace(namespace) {
                return Err(ConfigError(format!(
                    "directory Skill source '{}' is outside the '{namespace}' namespace",
                    source_id
                )));
            }
            source.validate()?;
        }
        Ok(())
    }
}

/// Directory capability requests preserved after ordinary configuration resolution.
///
/// These requests are not active capabilities. Plugin, MCP, and Skill managers must combine them
/// with their own install, grant, and compatibility decisions before publishing runtime
/// snapshots.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirConfigIntent {
    pub dir_id: DirId,
    pub mcp: DirMcpConfig,
    pub plugin_requests: DirPluginRequests,
    pub skills: DirSkillsConfig,
    pub hooks: HooksConfig,
    pub exec_policy: DirExecPolicyConfig,
}

/// Typed, non-authoritative intent loaded from one directory configuration file.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirConfigDocument {
    #[serde(default)]
    pub agent: DirAgentConfig,
    #[serde(default)]
    pub mcp: DirMcpConfig,
    #[serde(default)]
    pub plugin_requests: DirPluginRequests,
    #[serde(default)]
    pub skills: DirSkillsConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub exec_policy: DirExecPolicyConfig,
}

impl DirConfigDocument {
    pub fn validate(&self, scope: &DirConfigScope) -> Result<(), ConfigError> {
        let namespace = scope.namespace();
        self.mcp.validate(&namespace)?;
        self.plugin_requests.validate()?;
        self.skills.validate(&namespace)?;
        self.hooks.validate_for_namespace(&namespace)?;
        self.exec_policy.snapshot_layer(&scope.dir_id)?;
        Ok(())
    }
}

/// Read-only source for one directory configuration document.
///
/// Directory config is intentionally not a command authority. A host supplies the directory
/// identity and grants each contribution through its owning capability authority.
pub struct DirConfigStore {
    path: PathBuf,
    scope: DirConfigScope,
}

impl DirConfigStore {
    pub fn open(path: impl Into<PathBuf>, scope: DirConfigScope) -> Self {
        Self {
            path: path.into(),
            scope,
        }
    }

    pub fn read_document(&self) -> Result<DirConfigDocument, ConfigError> {
        if !self.path.exists() {
            return Ok(DirConfigDocument::default());
        }
        let source = fs::read_to_string(&self.path).map_err(io_error)?;
        let document: DirConfigDocument =
            toml::from_str(&source).map_err(|error| ConfigError(error.to_string()))?;
        document.validate(&self.scope)?;
        Ok(document)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn scope(&self) -> &DirConfigScope {
        &self.scope
    }
}

fn validate_text(value: &str, label: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() || value.contains('\0') || value.contains(['\n', '\r']) {
        return Err(ConfigError(format!("{label} must be non-empty plain text")));
    }
    Ok(())
}

fn io_error(error: impl std::fmt::Display) -> ConfigError {
    ConfigError(error.to_string())
}
