use crate::{
    ConfigError, ConfigGeneration, ConfigRevision, DirConfigDocument, DirConfigIntent,
    DirConfigRevision, DirConfigScope, DirId, HookId, LanguageServerId, McpServerId,
    PluginPackageId, ResolvedConfig, ResolvedConfigSnapshot, SkillSourceId, UserConfigDocument,
};
use ash_protocol::{ModelRef, ProviderId};
use std::collections::BTreeMap;

/// Source that contributed a resolved value or pending capability request.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ConfigValueSource {
    #[default]
    User,
    Dir(DirId),
}

/// Origin information for consumer-visible configuration values.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConfigProvenance {
    pub issues: ConfigValueSource,
    pub model: Option<ConfigValueSource>,
    pub model_reasoning_effort: Option<ConfigValueSource>,
    pub approval_review_model: ConfigValueSource,
    pub commit_message_model: Option<ConfigValueSource>,
    pub providers: BTreeMap<ProviderId, ConfigValueSource>,
    pub mcp_servers: BTreeMap<McpServerId, ConfigValueSource>,
    pub skill_sources: BTreeMap<SkillSourceId, ConfigValueSource>,
    pub plugin_requests: BTreeMap<PluginPackageId, ConfigValueSource>,
    pub hooks: BTreeMap<HookId, ConfigValueSource>,
    pub language_servers: BTreeMap<LanguageServerId, ConfigValueSource>,
    pub tool_search: ConfigValueSource,
    pub codebase: ConfigValueSource,
}

impl ConfigProvenance {
    pub(crate) fn from_user(document: &UserConfigDocument) -> Self {
        Self {
            issues: ConfigValueSource::User,
            model: document
                .agent
                .model
                .as_ref()
                .map(|_| ConfigValueSource::User),
            model_reasoning_effort: document
                .agent
                .model_reasoning_effort
                .as_ref()
                .map(|_| ConfigValueSource::User),
            approval_review_model: ConfigValueSource::User,
            commit_message_model: document
                .agent
                .commit_message_model
                .as_ref()
                .map(|_| ConfigValueSource::User),
            providers: document
                .providers
                .keys()
                .cloned()
                .map(|id| (id, ConfigValueSource::User))
                .collect(),
            mcp_servers: document
                .mcp
                .servers
                .keys()
                .cloned()
                .map(|id| (id, ConfigValueSource::User))
                .collect(),
            skill_sources: document
                .skills
                .sources
                .keys()
                .cloned()
                .map(|id| (id, ConfigValueSource::User))
                .collect(),
            plugin_requests: document
                .plugins
                .requests
                .keys()
                .cloned()
                .map(|id| (id, ConfigValueSource::User))
                .collect(),
            hooks: document
                .hooks
                .hooks
                .keys()
                .cloned()
                .map(|id| (id, ConfigValueSource::User))
                .collect(),
            language_servers: document
                .language_servers
                .servers
                .keys()
                .cloned()
                .map(|id| (id, ConfigValueSource::User))
                .collect(),
            tool_search: ConfigValueSource::User,
            codebase: ConfigValueSource::User,
        }
    }
}

/// Stable category for a configuration diagnostic that does not rewrite desired configuration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigDiagnosticCode {
    DirModelProviderUnconfigured,
    DirMcpCapabilityRequired,
    DirSkillCapabilityRequired,
    DirPluginCapabilityRequired,
    DirHookCapabilityRequired,
}

/// Redacted explanation of why a requested configuration value is not immediately usable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigDiagnostic {
    pub code: ConfigDiagnosticCode,
    pub subject: String,
}

/// Immutable result of resolving User configuration with an optional directory document.
///
/// Its generation remains the User authority generation because directory observation has its own
/// revision. App Server composition will assign a new environment generation after it combines
/// this result with Plugin, MCP, Skill, credential, and policy snapshots.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedConfigSnapshot {
    pub user_revision: ConfigRevision,
    pub user_generation: ConfigGeneration,
    pub dir_revision: Option<DirConfigRevision>,
    pub values: ResolvedConfig,
    pub provenance: ConfigProvenance,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

/// Directory input passed to one configuration resolution.
pub struct DirConfigInput<'a> {
    pub scope: &'a DirConfigScope,
    pub revision: DirConfigRevision,
    pub document: &'a DirConfigDocument,
}

impl<'a> DirConfigInput<'a> {
    pub fn new(
        scope: &'a DirConfigScope,
        revision: DirConfigRevision,
        document: &'a DirConfigDocument,
    ) -> Self {
        Self {
            scope,
            revision,
            document,
        }
    }
}

/// Resolves ordinary User configuration with an optional, host-scoped directory document.
///
/// The resolver never treats directory requests as installed Plugins, connected MCP servers,
/// selected credential bindings, or active Skill content. Only a directory model preference may
/// override the User preference, and only when its provider is already configured by the User.
pub fn resolve_scoped_config(
    user: &ResolvedConfigSnapshot,
    dir: Option<DirConfigInput<'_>>,
) -> Result<ScopedConfigSnapshot, ConfigError> {
    let mut values = user.values.clone();
    let mut provenance = user.provenance.clone();
    let mut diagnostics = user.diagnostics.clone();
    let mut dir_revision = None;

    if let Some(dir) = dir {
        dir.document.validate(dir.scope)?;
        let dir_id = dir.scope.dir_id.clone();
        dir_revision = Some(dir.revision);

        if let Some(model) = &dir.document.agent.model {
            apply_dir_model_preference(
                &mut values,
                &mut provenance,
                &mut diagnostics,
                &dir_id,
                model,
            );
        }
        if let Some(effort) = dir.document.agent.model_reasoning_effort {
            values.model_reasoning_effort = Some(effort);
            provenance.model_reasoning_effort = Some(ConfigValueSource::Dir(dir_id.clone()));
        }

        let source = ConfigValueSource::Dir(dir_id.clone());
        provenance.mcp_servers.extend(
            dir.document
                .mcp
                .servers
                .keys()
                .cloned()
                .map(|id| (id, source.clone())),
        );
        provenance.skill_sources.extend(
            dir.document
                .skills
                .sources
                .keys()
                .cloned()
                .map(|id| (id, source.clone())),
        );
        provenance.plugin_requests.extend(
            dir.document
                .plugin_requests
                .requests
                .keys()
                .cloned()
                .map(|id| (id, source.clone())),
        );
        provenance.hooks.extend(
            dir.document
                .hooks
                .hooks
                .keys()
                .cloned()
                .map(|id| (id, source.clone())),
        );
        diagnostics.extend(dir.document.mcp.servers.keys().map(|id| ConfigDiagnostic {
            code: ConfigDiagnosticCode::DirMcpCapabilityRequired,
            subject: id.to_string(),
        }));
        diagnostics.extend(dir.document.plugin_requests.requests.keys().map(|id| {
            ConfigDiagnostic {
                code: ConfigDiagnosticCode::DirPluginCapabilityRequired,
                subject: id.to_string(),
            }
        }));
        diagnostics.extend(dir.document.hooks.hooks.keys().map(|id| ConfigDiagnostic {
            code: ConfigDiagnosticCode::DirHookCapabilityRequired,
            subject: id.to_string(),
        }));
        diagnostics.extend(
            dir.document
                .skills
                .sources
                .keys()
                .map(|id| ConfigDiagnostic {
                    code: ConfigDiagnosticCode::DirSkillCapabilityRequired,
                    subject: id.to_string(),
                }),
        );
        values.dir_config = Some(DirConfigIntent {
            dir_id,
            mcp: dir.document.mcp.clone(),
            plugin_requests: dir.document.plugin_requests.clone(),
            skills: dir.document.skills.clone(),
            hooks: dir.document.hooks.clone(),
            exec_policy: dir.document.exec_policy.clone(),
        });
    }

    Ok(ScopedConfigSnapshot {
        user_revision: user.revision,
        user_generation: user.generation,
        dir_revision,
        values,
        provenance,
        diagnostics,
    })
}

fn apply_dir_model_preference(
    values: &mut ResolvedConfig,
    provenance: &mut ConfigProvenance,
    diagnostics: &mut Vec<ConfigDiagnostic>,
    dir_id: &DirId,
    model: &ModelRef,
) {
    if values.providers.contains_key(&model.provider) {
        values.model = Some(model.clone());
        provenance.model = Some(ConfigValueSource::Dir(dir_id.clone()));
        return;
    }
    diagnostics.push(ConfigDiagnostic {
        code: ConfigDiagnosticCode::DirModelProviderUnconfigured,
        subject: model.provider.to_string(),
    });
}
