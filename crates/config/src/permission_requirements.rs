//! Administrator-owned ceilings loaded separately from the editable user artifact.
use crate::CommandNetworkAccess;
use crate::ConfigError;
use crate::HostReadAccess;
use crate::ResolvedPermissionProfile;
use ash_execpolicy::ExecPolicyDefault;
use ash_execpolicy::ExecPolicyEffect;
use ash_execpolicy::ExecPolicyLayer;
use ash_execpolicy::ExecPolicyLayerId;
use ash_execpolicy::ExecPolicyLayerKind;
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicySnapshot;
use ash_file_access::PathAccessRule;
use ash_protocol::ApprovalMode;
use ash_protocol::SandboxMode;
use serde::Deserialize;
use serde::Serialize;

/// Mandatory limits. This contract is not a field of UserConfigDocument and cannot be written by its commands.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRequirements {
    pub maximum_file_system: Option<SandboxMode>,
    pub maximum_network: Option<CommandNetworkAccess>,
    pub host_read: Option<HostReadAccess>,
    pub allowed_approval_modes: Option<Vec<ApprovalMode>>,
    pub approval_prompts: Option<crate::ApprovalPromptControls>,
    #[serde(default)]
    pub paths: Vec<PathAccessRule>,
    #[serde(default)]
    pub rules: Vec<ExecPolicyRule>,
}

impl PermissionRequirements {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.paths.len() > 1024 || self.rules.len() > 1024 {
            return Err(ConfigError("too many managed permission rules".into()));
        }
        for rule in &self.paths {
            rule.validate().map_err(ConfigError)?;
        }
        if let Some(modes) = &self.allowed_approval_modes {
            if modes.is_empty() || modes.len() > ApprovalMode::ALL.len() {
                return Err(ConfigError(
                    "managed approval modes must be a non-empty bounded set".into(),
                ));
            }
            for (index, mode) in modes.iter().enumerate() {
                if modes[..index].contains(mode) {
                    return Err(ConfigError(
                        "managed approval modes contain duplicates".into(),
                    ));
                }
            }
        }
        self.layer().map(|_| ())
    }

    /// Managed rules restrict execution; they never supply an ambient authorization grant.
    pub fn layer(&self) -> Result<ExecPolicyLayer, ConfigError> {
        if self
            .rules
            .iter()
            .any(|rule| matches!(rule.effect(), ExecPolicyEffect::AllowUnsandboxed))
        {
            return Err(ConfigError(
                "managed permission requirements cannot grant unsandboxed execution".into(),
            ));
        }
        let layer = ExecPolicyLayer::new(
            ExecPolicyLayerId::new("system-requirements"),
            ExecPolicyLayerKind::Organization,
            self.rules.clone(),
        );
        ExecPolicySnapshot::new(ExecPolicyDefault::Continue, vec![layer.clone()])
            .map_err(|error| ConfigError(error.to_string()))?;
        Ok(layer)
    }

    pub fn check_approval_mode(&self, mode: ApprovalMode) -> Result<(), ConfigError> {
        if self
            .allowed_approval_modes
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(&mode))
        {
            return Err(ConfigError(
                "approval mode is prohibited by system permission requirements".into(),
            ));
        }
        Ok(())
    }

    pub fn constrain(
        &self,
        mut profile: ResolvedPermissionProfile,
    ) -> Result<ResolvedPermissionProfile, ConfigError> {
        self.validate()?;
        if self.maximum_file_system == Some(SandboxMode::ReadOnly) {
            profile.file_operations = ash_file_access::PathAccess::ReadOnly;
        }
        if let Some(maximum) = self.maximum_file_system {
            profile.file_system = match (profile.file_system, maximum) {
                (SandboxMode::ReadOnly, _) | (_, SandboxMode::ReadOnly) => SandboxMode::ReadOnly,
                (SandboxMode::DirectoryWrite, _) | (_, SandboxMode::DirectoryWrite) => {
                    SandboxMode::DirectoryWrite
                }
                (SandboxMode::FullAccess, SandboxMode::FullAccess) => SandboxMode::FullAccess,
            };
        }
        if self.maximum_network == Some(CommandNetworkAccess::Denied) {
            profile.network = CommandNetworkAccess::Denied;
        }
        if self.host_read == Some(HostReadAccess::GrantedRoots) {
            profile.host_read = HostReadAccess::GrantedRoots;
        }
        profile.paths.extend(self.paths.clone());
        if profile.paths.len() > 2048 {
            return Err(ConfigError("too many resolved permission rules".into()));
        }
        Ok(profile)
    }

    pub fn has_execution_ceiling(&self) -> bool {
        self.maximum_file_system.is_some()
            || self.maximum_network.is_some()
            || self.host_read.is_some()
            || !self.paths.is_empty()
    }
}
