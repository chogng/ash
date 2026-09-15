use crate::{ConfigError, PreferencesUpdate, UserConfigCommand, UserConfigDocument};
use ash_model_provider_config::STATIC_MODEL_CATALOG;
use ash_model_provider_config::StaticModelRuntime;
use ash_protocol::Patch;

pub(crate) fn apply_command(
    document: &mut UserConfigDocument,
    command: &UserConfigCommand,
) -> Result<(), ConfigError> {
    match command {
        UserConfigCommand::ConfigureIssues { config } => document.issues = config.clone(),
        UserConfigCommand::UpdatePreferences(update) => apply_preferences(document, update),
        UserConfigCommand::ConfigureProvider { provider, config } => {
            if &config.provider != provider {
                return Err(ConfigError(format!(
                    "provider command key '{}' does not match configuration provider '{}'",
                    provider, config.provider
                )));
            }
            let mut config = config.clone();
            if let Some(custom) = &mut config.custom {
                custom.order = match document
                    .providers
                    .get(provider)
                    .and_then(|entry| entry.custom.as_ref())
                {
                    Some(previous) => previous.order,
                    None => document
                        .providers
                        .values()
                        .filter_map(|entry| entry.custom.as_ref())
                        .map(|entry| entry.order)
                        .max()
                        .unwrap_or(0)
                        .checked_add(1)
                        .ok_or_else(|| ConfigError("provider order exhausted".into()))?,
                };
            }
            document.providers.insert(provider.clone(), config);
            if document.agent.model.is_none() {
                document.agent.model = STATIC_MODEL_CATALOG
                    .iter()
                    .find(|model| {
                        model.provider_id == provider.as_str()
                            && model.runtime == StaticModelRuntime::ProviderApi
                    })
                    .map(|model| model.model_ref());
            }
        }
        UserConfigCommand::RemoveProvider { provider } => {
            if document
                .agent
                .model
                .as_ref()
                .is_some_and(|model| model.provider == *provider)
            {
                return Err(ConfigError(format!(
                    "cannot remove provider '{}' while it is the model provider",
                    provider
                )));
            }
            if document
                .agent
                .approval_review_model
                .explicit_model()
                .is_some_and(|model| model.provider == *provider)
            {
                return Err(ConfigError(format!(
                    "cannot remove provider '{}' while it is the approval review model provider",
                    provider
                )));
            }
            if document
                .agent
                .commit_message_model
                .as_ref()
                .is_some_and(|model| model.provider == *provider)
            {
                return Err(ConfigError(format!(
                    "cannot remove provider '{}' while it is the commit-message model provider",
                    provider
                )));
            }
            if document.codebase.models.as_ref().is_some_and(|models| {
                models.embedding_model.provider == *provider
                    || models
                        .rerank_model
                        .as_ref()
                        .is_some_and(|model| model.provider == *provider)
            }) {
                return Err(ConfigError(format!(
                    "cannot remove provider '{}' while Codebase models use it",
                    provider
                )));
            }
            if document
                .tool_search
                .embedding_model
                .as_ref()
                .is_some_and(|model| model.provider == *provider)
            {
                return Err(ConfigError(format!(
                    "cannot remove provider '{}' while Tool Search uses it",
                    provider
                )));
            }
            document.providers.remove(provider);
        }
        UserConfigCommand::UpsertMcpServer { server } => {
            document
                .mcp
                .servers
                .insert(server.id.clone(), server.clone());
        }
        UserConfigCommand::RemoveMcpServer { server_id } => {
            document.mcp.servers.remove(server_id);
        }
        UserConfigCommand::SetMcpServerEnablement {
            server_id,
            enablement,
        } => {
            let server = document.mcp.servers.get_mut(server_id).ok_or_else(|| {
                ConfigError(format!("MCP server '{}' is not configured", server_id))
            })?;
            server.enablement = *enablement;
        }
        UserConfigCommand::AddSkillSource { source } => {
            document
                .skills
                .sources
                .insert(source.id.clone(), source.clone());
        }
        UserConfigCommand::RemoveSkillSource { source_id } => {
            document.skills.sources.remove(source_id);
        }
        UserConfigCommand::SetSkillSourceEnablement {
            source_id,
            enablement,
        } => {
            let source = document.skills.sources.get_mut(source_id).ok_or_else(|| {
                ConfigError(format!("Skill source '{}' is not configured", source_id))
            })?;
            source.enablement = *enablement;
        }
        UserConfigCommand::SetSkillEnablement {
            skill_id,
            enablement,
        } => {
            document.skills.set_skill_enablement(skill_id, *enablement);
        }
        UserConfigCommand::UpsertPluginRequest { request } => {
            document
                .plugins
                .requests
                .insert(request.plugin_id.clone(), request.clone());
        }
        UserConfigCommand::RemovePluginRequest { plugin_id } => {
            document.plugins.requests.remove(plugin_id);
        }
        UserConfigCommand::SetPluginRequestEnablement {
            plugin_id,
            enablement,
        } => {
            let request = document
                .plugins
                .requests
                .get_mut(plugin_id)
                .ok_or_else(|| ConfigError(format!("Plugin '{}' is not requested", plugin_id)))?;
            request.enablement = *enablement;
        }
        UserConfigCommand::UpsertHook { hook } => {
            document.hooks.hooks.insert(hook.id.clone(), hook.clone());
        }
        UserConfigCommand::RemoveHook { hook_id } => {
            document.hooks.hooks.remove(hook_id);
        }
        UserConfigCommand::SetHookEnablement {
            hook_id,
            enablement,
        } => {
            let hook = document
                .hooks
                .hooks
                .get_mut(hook_id)
                .ok_or_else(|| ConfigError(format!("Hook '{}' is not configured", hook_id)))?;
            hook.enablement = *enablement;
        }
        UserConfigCommand::ConfigureLanguageServer { server_id, config } => {
            config.validate()?;
            document
                .language_servers
                .servers
                .insert(server_id.clone(), config.clone());
        }
        UserConfigCommand::RemoveLanguageServerConfiguration { server_id } => {
            document.language_servers.servers.remove(server_id);
        }
        UserConfigCommand::ConfigureCodebase {
            models,
            automatic_context,
        } => {
            document.codebase.replace_models(models.clone());
            document
                .codebase
                .replace_automatic_context(*automatic_context);
        }
        UserConfigCommand::ConfigureToolSearch { config } => {
            document.tool_search = config.clone();
        }
        UserConfigCommand::AuthorizeCommitMessageEgress { dir } => {
            document
                .commit_messages
                .authorize(
                    dir.clone(),
                    document.agent.commit_message_model.as_ref(),
                    &document.providers,
                )
                .map_err(|message| ConfigError(message.into()))?;
        }
        UserConfigCommand::RevokeCommitMessageEgress { dir } => {
            document.commit_messages.revoke(dir);
        }
        UserConfigCommand::SetDirPermissions {
            dir,
            permissions,
            display_path,
        } => {
            document
                .dir_permissions
                .entries
                .insert(dir.clone(), permissions.clone());
            if let Some(display_path) = display_path {
                document
                    .dir_permissions
                    .paths
                    .insert(dir.clone(), display_path.clone());
            }
        }
        UserConfigCommand::ForgetDirPermissions { dir } => {
            document.dir_permissions.entries.remove(dir);
            document.dir_permissions.paths.remove(dir);
        }
        UserConfigCommand::UpsertExecPolicyRule { rule } => {
            document.exec_policy.upsert(rule.clone());
        }
        UserConfigCommand::RemoveExecPolicyRule { rule_id } => {
            if !document.exec_policy.remove(rule_id) {
                return Err(ConfigError(format!(
                    "execution-policy rule '{}' is not configured",
                    rule_id.as_str()
                )));
            }
        }
    }
    Ok(())
}

fn apply_preferences(document: &mut UserConfigDocument, update: &PreferencesUpdate) {
    match &update.features {
        Patch::Missing => {}
        Patch::Null => document.features.clear(),
        Patch::Value(values) => document.features = values.clone(),
    }
    match &update.model {
        Patch::Missing => {}
        Patch::Null => document.agent.model = None,
        Patch::Value(model) => document.agent.model = Some(model.clone()),
    }
    match &update.model_reasoning_effort {
        Patch::Missing => {}
        Patch::Null => document.agent.model_reasoning_effort = None,
        Patch::Value(effort) => document.agent.model_reasoning_effort = Some(*effort),
    }
    match &update.approval_review_model {
        Patch::Missing => {}
        Patch::Null => {
            document.agent.approval_review_model = crate::ApprovalReviewModelSelection::Automatic;
        }
        Patch::Value(selection) => {
            document.agent.approval_review_model = selection.clone();
        }
    }
    match &update.commit_message_model {
        Patch::Missing => {}
        Patch::Null => {
            if document.agent.commit_message_model.take().is_some() {
                document.commit_messages.revoke_all();
            }
        }
        Patch::Value(model) => {
            if document.agent.commit_message_model.as_ref() != Some(model) {
                document.agent.commit_message_model = Some(model.clone());
                document.commit_messages.revoke_all();
            }
        }
    }
    match &update.tool_mode {
        Patch::Missing => {}
        Patch::Null => document.agent.tool_mode = ash_protocol::ToolMode::Direct,
        Patch::Value(tool_mode) => document.agent.tool_mode = *tool_mode,
    }
    match &update.grep_backend {
        Patch::Missing => {}
        Patch::Null => document.grep.backend = crate::GrepBackend::default(),
        Patch::Value(backend) => document.grep.backend = *backend,
    }
    match &update.time_context {
        Patch::Missing => {}
        Patch::Null => document.agent.time_context = crate::TimeContextConfig::default(),
        Patch::Value(config) => document.agent.time_context = config.clone(),
    }
    match &update.gui {
        Patch::Missing => {}
        Patch::Null => document.gui.clear(),
        Patch::Value(gui) => document.gui = gui.clone(),
    }
    match &update.tui {
        Patch::Missing => {}
        Patch::Null => document.tui.clear(),
        Patch::Value(tui) => document.tui = tui.clone(),
    }
}
