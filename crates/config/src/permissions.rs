//! User-selected permission profiles; directory grants continue to own operation capabilities.

use crate::CommandNetworkAccess;
use crate::ConfigError;
use ash_file_access::PathAccess;
use ash_file_access::PathAccessPolicy;
use ash_file_access::PathAccessRule;
use ash_protocol::SandboxMode;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub use ash_file_access::HostReadAccess;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionProfileConfig {
    pub extends: Option<String>,
    pub file_system: Option<SandboxMode>,
    pub host_read: Option<HostReadAccess>,
    #[serde(default)]
    pub paths: Vec<PathAccessRule>,
    pub network: Option<CommandNetworkAccess>,
}

/// Availability of user approval prompts by their owning operation category.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ApprovalPromptControls {
    pub commands: bool,
    pub file_mutations: bool,
    pub sandbox_retries: bool,
    pub network: bool,
    pub mcp: bool,
    pub permission_requests: bool,
}

impl Default for ApprovalPromptControls {
    fn default() -> Self {
        Self {
            commands: true,
            file_mutations: true,
            sandbox_retries: true,
            network: true,
            mcp: true,
            permission_requests: true,
        }
    }
}

impl ApprovalPromptControls {
    pub fn allows(
        &self,
        kind: &ash_protocol::ActionKind,
        source: &ash_protocol::ActionSource,
        phase: &ash_protocol::ActionReviewPhase,
    ) -> bool {
        if matches!(phase, ash_protocol::ActionReviewPhase::SandboxDenial(_))
            && !self.sandbox_retries
        {
            return false;
        }
        if *source == ash_protocol::ActionSource::McpServer && !self.mcp {
            return false;
        }
        match kind {
            ash_protocol::ActionKind::LocalProcess(_) => self.commands,
            ash_protocol::ActionKind::FileSystemMutation => self.file_mutations,
            ash_protocol::ActionKind::NetworkRequest => self.network,
            _ => true,
        }
    }
}

/// Canonical user artifact for named profile inheritance and selection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionsConfig {
    #[serde(default)]
    pub approval_prompts: ApprovalPromptControls,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, PermissionProfileConfig>,
}

impl Default for PermissionsConfig {
    fn default() -> Self {
        Self {
            approval_prompts: ApprovalPromptControls::default(),
            default_profile: None,
            profiles: BTreeMap::new(),
        }
    }
}

/// Whether a profile constrains process defaults or all Agent operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PermissionProfileScope {
    Commands,
    AllOperations,
}

/// Fully resolved intent consumed by operation and process owners.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedPermissionProfile {
    pub name: String,
    pub scope: PermissionProfileScope,
    pub file_operations: PathAccess,
    pub file_system: SandboxMode,
    pub host_read: HostReadAccess,
    pub paths: Vec<PathAccessRule>,
    pub network: CommandNetworkAccess,
}

impl PermissionsConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.profiles.len() > 128 {
            return Err(ConfigError("too many permission profiles".into()));
        }
        for name in self.profiles.keys() {
            if name.is_empty() || name.len() > 128 || name.starts_with(':') || name.trim() != name {
                return Err(ConfigError(
                    "permission profile name is empty, reserved, or invalid".into(),
                ));
            }
            self.resolve(name)?;
        }
        match &self.default_profile {
            Some(name) => self.resolve(name).map(|_| ()),
            None => Ok(()),
        }
    }

    /// Explicit profiles take precedence over command defaults; absent selection keeps the
    /// existing execution intent, while operation capabilities still come from directory grants.
    pub fn active(
        &self,
        execution: crate::ExecutionConfig,
    ) -> Result<ResolvedPermissionProfile, ConfigError> {
        if let Some(name) = &self.default_profile {
            return self.resolve(name);
        }
        Ok(ResolvedPermissionProfile {
            name: "command-defaults".into(),
            scope: PermissionProfileScope::Commands,
            file_operations: PathAccess::ReadWrite,
            file_system: match execution.command_file_access {
                crate::CommandFileAccess::ReadOnly => SandboxMode::ReadOnly,
                crate::CommandFileAccess::DirectoryWrite => SandboxMode::DirectoryWrite,
            },
            host_read: HostReadAccess::Host,
            paths: Vec::new(),
            network: execution.command_network_access,
        })
    }

    pub fn resolve(&self, name: &str) -> Result<ResolvedPermissionProfile, ConfigError> {
        let mut visiting = BTreeSet::new();
        self.resolve_inner(name, &mut visiting)
    }

    fn resolve_inner(
        &self,
        name: &str,
        visiting: &mut BTreeSet<String>,
    ) -> Result<ResolvedPermissionProfile, ConfigError> {
        let builtin = match name {
            ":readOnly" => Some((
                SandboxMode::ReadOnly,
                HostReadAccess::GrantedRoots,
                CommandNetworkAccess::Denied,
            )),
            ":workspace" => Some((
                SandboxMode::DirectoryWrite,
                HostReadAccess::Host,
                CommandNetworkAccess::Denied,
            )),
            ":fullAccess" => Some((
                SandboxMode::FullAccess,
                HostReadAccess::Host,
                CommandNetworkAccess::Allowed,
            )),
            _ => None,
        };
        if let Some((file_system, host_read, network)) = builtin {
            return Ok(ResolvedPermissionProfile {
                name: name.into(),
                scope: PermissionProfileScope::AllOperations,
                file_operations: if file_system == SandboxMode::ReadOnly {
                    PathAccess::ReadOnly
                } else {
                    PathAccess::ReadWrite
                },
                file_system,
                host_read,
                paths: Vec::new(),
                network,
            });
        }
        if !visiting.insert(name.into()) {
            return Err(ConfigError("permission profile inheritance cycle".into()));
        }
        let profile = self
            .profiles
            .get(name)
            .ok_or_else(|| ConfigError(format!("unknown permission profile {name}")))?;
        let mut resolved =
            self.resolve_inner(profile.extends.as_deref().unwrap_or(":workspace"), visiting)?;
        visiting.remove(name);
        resolved.name = name.into();
        if let Some(access) = profile.file_system {
            resolved.file_system = access;
            resolved.file_operations = if access == SandboxMode::ReadOnly {
                PathAccess::ReadOnly
            } else {
                PathAccess::ReadWrite
            };
        }
        if let Some(access) = profile.host_read {
            resolved.host_read = access;
        }
        if let Some(access) = profile.network {
            resolved.network = access;
        }
        if profile.paths.len() + resolved.paths.len() > 1024 {
            return Err(ConfigError("too many filesystem permission rules".into()));
        }
        for rule in &profile.paths {
            rule.validate().map_err(ConfigError)?;
        }
        resolved.paths.extend(profile.paths.clone());
        Ok(resolved)
    }
}

impl ResolvedPermissionProfile {
    pub fn path_policy(&self) -> Result<PathAccessPolicy, ConfigError> {
        PathAccessPolicy::new(self.file_operations, self.paths.clone())
            .map(|policy| policy.with_host_read(self.host_read))
            .map_err(ConfigError)
    }
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
