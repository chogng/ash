use crate::CodebaseConfig;
use crate::CommitMessageConfig;
use crate::ConfigDiagnostic;
use crate::ConfigError;
use crate::ConfigProvenance;
use crate::DirConfigIntent;
use crate::DirPermissionsConfig;
use crate::HooksConfig;
use crate::LanguageServersConfig;
use crate::McpConfig;
use crate::PluginsConfig;
use crate::SkillsConfig;
use crate::ToolSearchConfig;
use crate::UserExecPolicyConfig;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderConfigError;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::HashMap;

/// User-selected model source for automatic approval review.
///
/// `Automatic` follows the active Agent model's provider and delegates the exact model choice to
/// that provider's definition. `Explicit` binds review to one configured provider/model without
/// changing the main Agent model.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ApprovalReviewModelSelection {
    #[default]
    Automatic,
    Explicit {
        model: ModelRef,
    },
}

impl ApprovalReviewModelSelection {
    pub fn explicit_model(&self) -> Option<&ModelRef> {
        match self {
            Self::Automatic => None,
            Self::Explicit { model } => Some(model),
        }
    }
}

/// Monotonic revision of the user configuration authority.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct ConfigRevision(u64);

impl ConfigRevision {
    pub const INITIAL: Self = Self(0);

    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

/// Consumer-visible generation of the resolved user configuration snapshot.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(transparent)]
pub struct ConfigGeneration(u64);

impl ConfigGeneration {
    pub const INITIAL: Self = Self(0);

    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

/// Selects the implementation behind the Agent-only `grep` Tool.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum AgentGrepBackend {
    #[default]
    Ripgrep,
    FastRegex,
}

/// Agent defaults that may be resolved into future model invocations.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    #[serde(default)]
    pub time_context: crate::TimeContextConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub approval_review_model: ApprovalReviewModelSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_message_model: Option<ModelRef>,
    #[serde(default)]
    pub tool_mode: ash_protocol::ToolMode,
    #[serde(default)]
    pub grep_backend: AgentGrepBackend,
}

/// Durable, non-secret user intent for ordinary Ash configuration.
///
/// Provider entries are keyed by `ProviderId`; each value repeats its provider identity so a
/// serialized document remains self-describing and mismatched entries can be rejected.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserConfigDocument {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub features: features::FeatureOverrides,
    #[serde(default)]
    pub issues: crate::IssueConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub providers: BTreeMap<ProviderId, ModelProviderConfig>,
    #[serde(default)]
    pub mcp: McpConfig,
    #[serde(default)]
    pub skills: SkillsConfig,
    #[serde(default)]
    pub plugins: PluginsConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    #[serde(default)]
    pub language_servers: LanguageServersConfig,
    #[serde(default)]
    pub tool_search: ToolSearchConfig,
    #[serde(default)]
    pub codebase: CodebaseConfig,
    #[serde(default)]
    pub commit_messages: CommitMessageConfig,
    #[serde(default)]
    pub exec_policy: UserExecPolicyConfig,
    #[serde(default)]
    pub dir_permissions: DirPermissionsConfig,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gui: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tui: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub desktop: HashMap<String, serde_json::Value>,
}

impl UserConfigDocument {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        self.agent.time_context.validate()?;
        ProviderConfigRegistry::new()
            .with_configs(self.providers.values())
            .map_err(provider_config_error)?;
        for (provider_id, provider) in &self.providers {
            if provider.provider != *provider_id {
                return Err(ConfigError(format!(
                    "provider entry '{}' contains configuration for '{}'",
                    provider_id, provider.provider
                )));
            }
            provider
                .validate_static()
                .map_err(|error| ConfigError(error.to_string()))?;
        }
        if ![0, 5, 10, 30, 60].contains(&self.issues.auto_refresh_minutes) {
            return Err(ConfigError(
                "issues.autoRefreshMinutes must be 0, 5, 10, 30 or 60".into(),
            ));
        }
        if let Some(model) = &self.agent.model
            && !self.providers.contains_key(&model.provider)
        {
            return Err(ConfigError(format!(
                "model provider '{}' is not configured",
                model.provider
            )));
        }
        if let Some(model) = self.agent.approval_review_model.explicit_model()
            && !self.providers.contains_key(&model.provider)
        {
            return Err(ConfigError(format!(
                "approval review model provider '{}' is not configured",
                model.provider
            )));
        }
        if let Some(model) = &self.agent.commit_message_model
            && !self.providers.contains_key(&model.provider)
        {
            return Err(ConfigError(format!(
                "commit-message model provider '{}' is not configured",
                model.provider
            )));
        }
        if let Some(models) = self.codebase.models.as_ref() {
            for (role, model) in [
                ("embedding", &models.embedding_model),
                (
                    "rerank",
                    models
                        .rerank_model
                        .as_ref()
                        .unwrap_or(&models.embedding_model),
                ),
            ] {
                if role == "rerank" && models.rerank_model.is_none() {
                    continue;
                }
                if !self.providers.contains_key(&model.provider) {
                    return Err(ConfigError(format!(
                        "semantic codebase {role} provider '{}' is not configured",
                        model.provider
                    )));
                }
            }
        }
        if self.tool_search.mode == crate::ToolSearchModeConfig::HybridEmbedding
            && self.tool_search.embedding_model.is_none()
        {
            return Err(ConfigError(
                "hybrid embedding Tool Search requires an embedding model".into(),
            ));
        }
        if let Some(model) = &self.tool_search.embedding_model
            && !self.providers.contains_key(&model.provider)
        {
            return Err(ConfigError(format!(
                "Tool Search embedding provider '{}' is not configured",
                model.provider
            )));
        }
        self.mcp.validate_for_namespace("user")?;
        self.skills.validate_for_namespace("user")?;
        self.plugins.validate()?;
        self.hooks.validate_for_namespace("user")?;
        self.language_servers.validate()?;
        self.exec_policy.validate()?;
        Ok(())
    }
}

/// Effective configuration derived from the currently supported user configuration sources.
///
/// Additional sources such as Directory documents and session defaults will be resolved into this
/// type without exposing file or authority implementation details to runtime consumers.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResolvedConfig {
    pub time_context: crate::TimeContextConfig,
    pub features: features::FeatureOverrides,
    pub issues: crate::IssueConfig,
    pub model: Option<ModelRef>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub approval_review_model: ApprovalReviewModelSelection,
    pub commit_message_model: Option<ModelRef>,
    pub tool_mode: ash_protocol::ToolMode,
    pub agent_grep_backend: AgentGrepBackend,
    pub providers: BTreeMap<ProviderId, ModelProviderConfig>,
    pub mcp: McpConfig,
    pub skills: SkillsConfig,
    pub plugins: PluginsConfig,
    pub hooks: HooksConfig,
    pub language_servers: LanguageServersConfig,
    pub tool_search: ToolSearchConfig,
    pub codebase: CodebaseConfig,
    pub commit_messages: CommitMessageConfig,
    pub exec_policy: UserExecPolicyConfig,
    pub dir_permissions: DirPermissionsConfig,
    pub gui: BTreeMap<String, serde_json::Value>,
    pub tui: BTreeMap<String, serde_json::Value>,
    pub desktop: HashMap<String, serde_json::Value>,
    pub dir_config: Option<DirConfigIntent>,
}

impl ResolvedConfig {
    pub fn selected_provider(&self) -> Option<&ModelProviderConfig> {
        self.model
            .as_ref()
            .and_then(|model| self.providers.get(&model.provider))
    }

    pub fn selected_approval_review_provider(&self) -> Option<&ModelProviderConfig> {
        match &self.approval_review_model {
            ApprovalReviewModelSelection::Automatic => self.selected_provider(),
            ApprovalReviewModelSelection::Explicit { model } => self.providers.get(&model.provider),
        }
    }

    /// Resolves and preflights the review model selected for the next approval assessment.
    ///
    /// Automatic selection follows the active Agent provider. Explicit selection remains fixed.
    /// This validates local provider configuration and static catalog availability; credentials,
    /// subscription entitlement, and remote availability are validated by the runtime invocation.
    pub fn resolve_approval_review_model(
        &self,
        registry: &ProviderConfigRegistry,
    ) -> Result<ModelRef, ConfigError> {
        let registry = registry
            .with_configs(self.providers.values())
            .map_err(provider_config_error)?;
        let model = match &self.approval_review_model {
            ApprovalReviewModelSelection::Automatic => {
                let active_model = self.model.as_ref().ok_or_else(|| {
                    ConfigError("automatic approval review requires a configured model".into())
                })?;
                registry
                    .automatic_approval_review_model(active_model)
                    .map_err(provider_config_error)?
            }
            ApprovalReviewModelSelection::Explicit { model } => model.clone(),
        };
        let provider = self.providers.get(&model.provider).ok_or_else(|| {
            ConfigError(format!(
                "approval review model provider '{}' is not configured",
                model.provider
            ))
        })?;
        registry
            .normalize_for(provider, &model.provider)
            .map_err(provider_config_error)?;
        registry
            .validate_model_selection(&model)
            .map_err(provider_config_error)?;
        Ok(model)
    }
}

fn provider_config_error(error: ProviderConfigError) -> ConfigError {
    ConfigError(error.to_string())
}

impl From<&UserConfigDocument> for ResolvedConfig {
    fn from(document: &UserConfigDocument) -> Self {
        Self {
            time_context: document.agent.time_context.clone(),
            features: document.features.clone(),
            issues: document.issues.clone(),
            model: document.agent.model.clone(),
            model_reasoning_effort: document.agent.model_reasoning_effort,
            approval_review_model: document.agent.approval_review_model.clone(),
            commit_message_model: document.agent.commit_message_model.clone(),
            tool_mode: document.agent.tool_mode,
            agent_grep_backend: document.agent.grep_backend,
            providers: document.providers.clone(),
            mcp: document.mcp.clone(),
            skills: document.skills.clone(),
            plugins: document.plugins.clone(),
            hooks: document.hooks.clone(),
            language_servers: document.language_servers.clone(),
            tool_search: document.tool_search.clone(),
            codebase: document.codebase.clone(),
            commit_messages: document.commit_messages.clone(),
            exec_policy: document.exec_policy.clone(),
            dir_permissions: document.dir_permissions.clone(),
            gui: document.gui.clone(),
            tui: document.tui.clone(),
            desktop: document.desktop.clone(),
            dir_config: None,
        }
    }
}

/// Immutable configuration input used by one runtime safe point.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedConfigSnapshot {
    pub revision: ConfigRevision,
    pub generation: ConfigGeneration,
    pub values: ResolvedConfig,
    pub provenance: ConfigProvenance,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

impl ResolvedConfigSnapshot {
    pub(crate) fn from_document(
        revision: ConfigRevision,
        generation: ConfigGeneration,
        document: &UserConfigDocument,
    ) -> Self {
        Self {
            revision,
            generation,
            values: ResolvedConfig::from(document),
            provenance: ConfigProvenance::from_user(document),
            diagnostics: Vec::new(),
        }
    }
}
