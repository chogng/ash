use crate::CodebaseConfig;
use crate::CommitMessageConfig;
use crate::ConfigDiagnostic;
use crate::ConfigError;
use crate::ConfigProvenance;
use crate::DirConfigIntent;
use crate::DirPermissionsConfig;
use crate::GitConfig;
use crate::HooksConfig;
use crate::LanguageServersConfig;
use crate::McpConfig;
use crate::PluginsConfig;
use crate::SkillsConfig;
use crate::ToolSearchConfig;
use crate::UserExecPolicyConfig;
use ash_protocol::ModelConnectionId;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use model_provider_info::ModelProviderConfig;
use model_provider_info::ProviderConfigError;
use model_provider_info::ProviderConfigRegistry;
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
    tag = "type",
    deny_unknown_fields
)]
pub enum ApprovalReviewModelSelection {
    #[default]
    Automatic,
    Explicit {
        model: ModelRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection: Option<ModelConnectionId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<ReasoningEffort>,
    },
}

impl ApprovalReviewModelSelection {
    pub fn explicit_model(&self) -> Option<&ModelRef> {
        match self {
            Self::Automatic => None,
            Self::Explicit { model, .. } => Some(model),
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

/// Selects the implementation used by the shared grep capability.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum GrepBackend {
    Ripgrep,
    #[default]
    Tgrep,
}

/// Directory content search defaults shared by every consumer.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrepConfig {
    #[serde(default)]
    pub backend: GrepBackend,
}

/// Hosts that Ash itself may contact over HTTP or WebSocket.
///
/// An absent list permits all hosts. An empty list disables application-owned
/// outbound connections. Entries are exact host names or IP addresses.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    #[serde(default)]
    pub http_mode: HttpCompatibilityMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_hosts: Option<Vec<String>>,
}

/// HTTP/2 negotiates the best supported HTTP version; HTTP/1.1 restricts ALPN for proxies.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum HttpCompatibilityMode {
    #[default]
    Http2,
    Http1,
}

impl NetworkConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        if let Some(hosts) = &self.allowed_hosts {
            for host in hosts {
                let valid = if host.contains(':') {
                    host == &host.to_ascii_lowercase()
                        && host
                            .parse::<std::net::IpAddr>()
                            .is_ok_and(|address| address.is_ipv6())
                } else {
                    !host.is_empty()
                        && host.len() <= 253
                        && host.split('.').all(|label| {
                            !label.is_empty()
                                && label.len() <= 63
                                && label
                                    .as_bytes()
                                    .first()
                                    .is_some_and(u8::is_ascii_alphanumeric)
                                && label
                                    .as_bytes()
                                    .last()
                                    .is_some_and(u8::is_ascii_alphanumeric)
                                && label.bytes().all(|byte| {
                                    byte.is_ascii_lowercase()
                                        || byte.is_ascii_digit()
                                        || byte == b'-'
                                })
                        })
                };
                if !valid {
                    return Err(ConfigError(format!(
                        "network.allowedHosts contains invalid host '{host}'"
                    )));
                }
            }
        }
        Ok(())
    }
}

/// Agent defaults that may be resolved into future model invocations.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    #[serde(default)]
    pub context: ash_protocol::ContextCompactionPolicy,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advisor: Option<ash_protocol::AdvisorConfig>,
    #[serde(default)]
    pub tool_mode: ash_protocol::ToolMode,
}

/// Durable, non-secret user intent for ordinary Ash configuration.
///
/// Saved connections and model preferences; credential readiness is resolved at invocation time.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserConfigDocument {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub features: features::FeatureOverrides,
    #[serde(default)]
    pub issues: crate::IssueConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitConfig>,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub grep: GrepConfig,
    #[serde(default)]
    pub network: NetworkConfig,
    #[serde(default)]
    pub message_board: crate::MessageBoardConfig,
    #[serde(default)]
    pub connections: BTreeMap<ModelConnectionId, ModelProviderConfig>,
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
    fn has_model_provider(&self, provider: &ProviderId) -> bool {
        ProviderConfigRegistry::builtin().get(provider).is_some()
            || self
                .connections
                .values()
                .any(|config| &config.provider == provider)
    }

    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        if let Some(git) = self.git {
            git.validate()?;
        }
        self.agent.time_context.validate()?;
        self.agent
            .context
            .validate()
            .map_err(|message| ConfigError(message.into()))?;
        self.network.validate()?;
        self.message_board.validate()?;
        if let Some(advisor) = &self.agent.advisor {
            advisor
                .validate()
                .map_err(|message| ConfigError(message.into()))?;
            if !self.has_model_provider(&advisor.model.provider) {
                return Err(ConfigError(format!(
                    "advisor model provider '{}' is not configured",
                    advisor.model.provider
                )));
            }
        }

        ProviderConfigRegistry::builtin()
            .with_configs(self.connections.values())
            .map_err(|error| ConfigError(error.to_string()))?;
        for (provider_id, provider) in &self.connections {
            if provider.connection != *provider_id {
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
            && !self.has_model_provider(&model.provider)
        {
            return Err(ConfigError(format!(
                "model provider '{}' is not configured",
                model.provider
            )));
        }
        if let Some(model) = self.agent.approval_review_model.explicit_model()
            && !self.has_model_provider(&model.provider)
        {
            return Err(ConfigError(format!(
                "approval review model provider '{}' is not configured",
                model.provider
            )));
        }
        if let ApprovalReviewModelSelection::Explicit { model, .. } =
            &self.agent.approval_review_model
        {
            approval_review_effort(&self.agent.approval_review_model, model)?;
        }
        if let ApprovalReviewModelSelection::Explicit {
            model,
            connection: Some(connection),
            ..
        } = &self.agent.approval_review_model
        {
            let configured = self.connections.get(connection).ok_or_else(|| {
                ConfigError(format!(
                    "approval review connection '{connection}' is not configured"
                ))
            })?;
            if configured.provider != model.provider {
                return Err(ConfigError(format!(
                    "approval review connection '{connection}' does not serve provider '{}'",
                    model.provider
                )));
            }
        }
        if let Some(model) = &self.agent.commit_message_model
            && !self.has_model_provider(&model.provider)
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
                if !self.has_model_provider(&model.provider) {
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
            && !self.has_model_provider(&model.provider)
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
    pub context: ash_protocol::ContextCompactionPolicy,
    pub time_context: crate::TimeContextConfig,
    pub features: features::FeatureOverrides,
    pub issues: crate::IssueConfig,
    pub git: GitConfig,
    pub git_configured: bool,
    pub model: Option<ModelRef>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub approval_review_model: ApprovalReviewModelSelection,
    pub commit_message_model: Option<ModelRef>,
    pub advisor: Option<ash_protocol::AdvisorConfig>,
    pub tool_mode: ash_protocol::ToolMode,
    pub grep_backend: GrepBackend,
    pub network: NetworkConfig,
    pub message_board: crate::MessageBoardConfig,
    pub providers: BTreeMap<ProviderId, ModelProviderConfig>,
    pub connections: BTreeMap<ModelConnectionId, ModelProviderConfig>,
    pub active_connections: BTreeMap<ProviderId, ModelConnectionId>,
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
            ApprovalReviewModelSelection::Explicit {
                model, connection, ..
            } => match connection {
                Some(connection) => self.connections.get(connection),
                None => self.providers.get(&model.provider),
            },
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
        Ok(self
            .resolve_approval_review_config(registry)?
            .model
            .expect("resolved review model"))
    }

    /// Freezes the review connection and effort independently of the Agent invocation.
    /// The source snapshot is never changed; credentials still belong to the selected connection.
    pub fn resolve_approval_review_config(
        &self,
        registry: &ProviderConfigRegistry,
    ) -> Result<Self, ConfigError> {
        let mut config = self.clone();
        if let ApprovalReviewModelSelection::Explicit {
            model,
            connection: Some(connection),
            ..
        } = &self.approval_review_model
        {
            let provider = self.connections.get(connection).ok_or_else(|| {
                ConfigError(format!(
                    "approval review connection '{connection}' is not configured"
                ))
            })?;
            if provider.provider != model.provider {
                return Err(ConfigError(format!(
                    "approval review connection '{connection}' does not serve provider '{}'",
                    model.provider
                )));
            }
            config
                .providers
                .insert(model.provider.clone(), provider.clone());
            config
                .active_connections
                .insert(model.provider.clone(), connection.clone());
        }
        let registry = registry
            .with_configs(config.providers.values())
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
            ApprovalReviewModelSelection::Explicit { model, .. } => model.clone(),
        };
        let provider = config.providers.get(&model.provider).ok_or_else(|| {
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
        config.model_reasoning_effort =
            approval_review_effort(&self.approval_review_model, &model)?;
        config.model = Some(model);
        Ok(config)
    }
}

fn approval_review_effort(
    selection: &ApprovalReviewModelSelection,
    model: &ModelRef,
) -> Result<Option<ReasoningEffort>, ConfigError> {
    let selected_effort = match selection {
        ApprovalReviewModelSelection::Automatic => None,
        ApprovalReviewModelSelection::Explicit {
            reasoning_effort, ..
        } => *reasoning_effort,
    };
    let spec = model_provider_info::find_static_model(model);
    if let (Some(effort), Some(spec)) = (selected_effort, spec)
        && !spec
            .supported_reasoning_efforts
            .iter()
            .any(|option| option.effort == effort)
    {
        return Err(ConfigError(format!(
            "approval review model '{}' does not support reasoning effort '{effort:?}'",
            model.model
        )));
    }
    Ok(selected_effort.or_else(|| {
        if model.provider.as_str() == "openai" && model.model.as_str() == "codex-auto-review" {
            Some(ReasoningEffort::Low)
        } else {
            spec.and_then(|spec| {
                if spec
                    .supported_reasoning_efforts
                    .iter()
                    .any(|option| option.effort == ReasoningEffort::Low)
                {
                    Some(ReasoningEffort::Low)
                } else {
                    spec.default_reasoning_effort
                }
            })
        }
    }))
}

fn provider_config_error(error: ProviderConfigError) -> ConfigError {
    ConfigError(error.to_string())
}

impl From<&UserConfigDocument> for ResolvedConfig {
    fn from(document: &UserConfigDocument) -> Self {
        let mut providers: BTreeMap<ProviderId, ModelProviderConfig> = BTreeMap::new();
        for config in document.connections.values() {
            let rank = model_provider_info::connection_priority(&config.connection);
            if providers.get(&config.provider).is_some_and(|current| {
                model_provider_info::connection_priority(&current.connection) <= rank
            }) {
                continue;
            }
            providers.insert(config.provider.clone(), config.clone());
        }
        let active_connections = providers
            .iter()
            .map(|(provider, config)| (provider.clone(), config.connection.clone()))
            .collect();
        Self {
            time_context: document.agent.time_context.clone(),
            context: document.agent.context.clone(),
            features: document.features.clone(),
            issues: document.issues.clone(),
            git: document.git.unwrap_or_default(),
            git_configured: document.git.is_some(),
            model: document.agent.model.clone(),
            model_reasoning_effort: document.agent.model_reasoning_effort,
            approval_review_model: document.agent.approval_review_model.clone(),
            commit_message_model: document.agent.commit_message_model.clone(),
            advisor: document.agent.advisor.clone(),
            tool_mode: document.agent.tool_mode,
            grep_backend: document.grep.backend,
            network: document.network.clone(),
            message_board: document.message_board.clone(),
            providers,
            connections: document.connections.clone(),
            active_connections,
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
