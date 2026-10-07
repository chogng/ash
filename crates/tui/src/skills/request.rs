use super::Command;
use super::Event;
use super::SkillChoices;
use super::skill_choices;
use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::skills::SkillCatalogReloadDto;
use ash_app_server_protocol::protocol::skills::SkillEnablementDto;
use ash_app_server_protocol::protocol::skills::SkillListParams;
use ash_app_server_protocol::protocol::skills::SkillSetEnablementParams;
use ash_protocol::SessionId;
use ash_protocol::SkillId;

impl Command {
    pub(crate) const fn request_name(&self) -> &'static str {
        match self {
            Self::SetEnablement { .. } => "ash-tui-set-skill-enablement",
        }
    }
}

pub(crate) fn execute<T>(
    client: &mut AppServerClient<T>,
    session_id: Option<&SessionId>,
    command: Command,
) -> Result<Event, String>
where
    T: JsonRpcTransport,
{
    match command {
        Command::SetEnablement {
            skill_id,
            enablement,
        } => set_enablement(client, session_id, skill_id, enablement),
    }
    .map(Event::SettingsUpdated)
    .map_err(|error| error.to_string())
}

pub(crate) fn load_selection<T>(
    client: &mut AppServerClient<T>,
    session_id: Option<&SessionId>,
    reload: SkillCatalogReloadDto,
) -> Result<SkillChoices, ClientError>
where
    T: JsonRpcTransport,
{
    client
        .list_skills(SkillListParams {
            reload,
            session_id: session_id.cloned(),
        })
        .map(|catalog| skill_choices(&catalog))
}

pub(crate) fn set_enablement<T>(
    client: &mut AppServerClient<T>,
    session_id: Option<&SessionId>,
    skill_id: SkillId,
    enablement: SkillEnablementDto,
) -> Result<SkillChoices, ClientError>
where
    T: JsonRpcTransport,
{
    let config = client.read_config()?;
    client.set_skill_enablement(SkillSetEnablementParams {
        command_id: new_command_id("skill-enablement"),
        expected_revision: config.revision,
        skill_id,
        enablement,
    })?;
    load_selection(client, session_id, SkillCatalogReloadDto::Cached)
}
