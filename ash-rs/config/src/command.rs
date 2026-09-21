use crate::CodebaseAutomaticContext;
use crate::CodebaseModelSelection;
use crate::ToolSearchConfig;
use crate::{
    ApprovalReviewModelSelection, ConfigGeneration, ConfigRevision, GrepBackend, HookConfig,
    HookEnablement, HookId, LanguageServerConfig, LanguageServerId, McpServerConfig,
    McpServerEnablement, McpServerId, ModelRef, PluginPackageId, PluginRequest,
    PluginRequestEnablement, SkillEnablement, SkillId, SkillSourceConfig, SkillSourceEnablement,
    SkillSourceId,
};
use ash_execpolicy::ExecPolicyRule;
use ash_execpolicy::ExecPolicyRuleId;
use ash_file_access::DirId;
use ash_file_access::Permissions;
use ash_model_provider_config::ModelProviderConfig;
use ash_protocol::CommandId;
use ash_protocol::Patch;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use ash_protocol::ToolMode;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A three-state update for user-facing preferences.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesUpdate {
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub time_context: Patch<crate::TimeContextConfig>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub features: Patch<features::FeatureOverrides>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub model: Patch<ModelRef>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub model_reasoning_effort: Patch<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub approval_review_model: Patch<ApprovalReviewModelSelection>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub commit_message_model: Patch<ModelRef>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub advisor: Patch<ash_protocol::AdvisorConfig>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub tool_mode: Patch<ToolMode>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub grep_backend: Patch<GrepBackend>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub gui: Patch<BTreeMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Patch::is_missing")]
    pub tui: Patch<BTreeMap<String, serde_json::Value>>,
}

/// Typed mutations accepted by the user configuration authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum UserConfigCommand {
    ConfigureIssues {
        config: crate::IssueConfig,
    },
    UpdatePreferences(PreferencesUpdate),
    ConfigureProvider {
        provider: ProviderId,
        config: ModelProviderConfig,
    },
    RemoveProvider {
        provider: ProviderId,
    },
    UpsertMcpServer {
        server: McpServerConfig,
    },
    RemoveMcpServer {
        server_id: McpServerId,
    },
    SetMcpServerEnablement {
        server_id: McpServerId,
        enablement: McpServerEnablement,
    },
    AddSkillSource {
        source: SkillSourceConfig,
    },
    RemoveSkillSource {
        source_id: SkillSourceId,
    },
    SetSkillSourceEnablement {
        source_id: SkillSourceId,
        enablement: SkillSourceEnablement,
    },
    SetSkillEnablement {
        skill_id: SkillId,
        enablement: SkillEnablement,
    },
    UpsertPluginRequest {
        request: PluginRequest,
    },
    RemovePluginRequest {
        plugin_id: PluginPackageId,
    },
    SetPluginRequestEnablement {
        plugin_id: PluginPackageId,
        enablement: PluginRequestEnablement,
    },
    UpsertHook {
        hook: HookConfig,
    },
    RemoveHook {
        hook_id: HookId,
    },
    SetHookEnablement {
        hook_id: HookId,
        enablement: HookEnablement,
    },
    ConfigureLanguageServer {
        server_id: LanguageServerId,
        config: LanguageServerConfig,
    },
    RemoveLanguageServerConfiguration {
        server_id: LanguageServerId,
    },
    ConfigureCodebase {
        models: Option<CodebaseModelSelection>,
        automatic_context: CodebaseAutomaticContext,
    },
    ConfigureToolSearch {
        config: ToolSearchConfig,
    },
    AuthorizeCommitMessageEgress {
        dir: DirId,
    },
    RevokeCommitMessageEgress {
        dir: DirId,
    },
    SetDirPermissions {
        dir: DirId,
        permissions: Permissions,
        /// Optional canonical path retained as non-authoritative display metadata.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_path: Option<PathBuf>,
    },
    ForgetDirPermissions {
        dir: DirId,
    },
    UpsertExecPolicyRule {
        rule: ExecPolicyRule,
    },
    RemoveExecPolicyRule {
        rule_id: ExecPolicyRuleId,
    },
}

/// Retry-safe request to mutate user configuration at one expected revision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCommandRequest {
    pub command_id: CommandId,
    pub expected_revision: ConfigRevision,
    pub command: UserConfigCommand,
}

/// Whether a configuration command committed a new revision or replayed a prior receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigCommandDisposition {
    Updated,
    Replayed,
}

/// Compact result of a durable configuration command.
///
/// Callers read the corresponding `ResolvedConfigSnapshot` separately. This keeps command
/// receipts independent of the full configuration document while preserving exact replay.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConfigCommandResult {
    pub revision: ConfigRevision,
    pub generation: ConfigGeneration,
    pub disposition: ConfigCommandDisposition,
}

/// Errors specific to retry-safe configuration command processing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigCommandError {
    Config(crate::ConfigError),
    CommandConflict,
    RevisionConflict {
        expected: ConfigRevision,
        actual: ConfigRevision,
    },
}

impl From<crate::ConfigError> for ConfigCommandError {
    fn from(error: crate::ConfigError) -> Self {
        Self::Config(error)
    }
}
