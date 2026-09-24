use super::SkillChoices;
use super::skill_choices;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::chat_input_catalog_snapshot;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_protocol::protocol::plugins::PluginPackageDto;
use ash_app_server_protocol::protocol::skills::SkillCatalogReloadDto;
use ash_app_server_protocol::protocol::skills::SkillListParams;
use ash_app_server_protocol::protocol::skills::SkillListResult;
use ash_app_server_protocol::protocol::slash_commands::SlashCommandDefinition;

pub(crate) struct SkillRefresh {
    pub(crate) catalog: SkillListResult,
    pub(crate) plugins: Vec<PluginPackageDto>,
}

pub(crate) struct SkillRefreshCompletion {
    pub(crate) input_catalog: ChatInputCatalog,
    pub(crate) choices: SkillChoices,
}

pub(crate) fn finish_refresh(
    refresh: SkillRefresh,
    server_slash_commands: &[SlashCommandDefinition],
) -> Result<SkillRefreshCompletion, String> {
    let input_catalog =
        chat_input_catalog_snapshot(server_slash_commands, &refresh.catalog, &refresh.plugins)
            .map_err(|error| error.to_string())?;
    Ok(SkillRefreshCompletion {
        input_catalog,
        choices: skill_choices(&refresh.catalog),
    })
}

pub(crate) fn refresh(
    mut client: AppServerRequestHandle,
    session_id: Option<ash_protocol::SessionId>,
    plugins_enabled: bool,
) -> Result<SkillRefresh, String> {
    let catalog = client
        .list_skills(SkillListParams {
            reload: SkillCatalogReloadDto::Cached,
            session_id,
        })
        .map_err(|error| error.to_string())?;
    let plugins = if plugins_enabled {
        client
            .list_plugins()
            .map_err(|error| error.to_string())?
            .packages
    } else {
        Vec::new()
    };
    Ok(SkillRefresh { catalog, plugins })
}
