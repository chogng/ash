use crate::client::new_command_id;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_protocol::AdvisorConfig;
use ash_protocol::AdvisorSelection;
use ash_protocol::Patch;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use std::collections::BTreeMap;

pub(crate) enum AdvisorUpdate {
    Picker(super::ModelChoices),
    Notice(String),
}

pub(crate) fn execute<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    session: &SessionId,
    thread: &ThreadId,
    argument: &str,
) -> Result<AdvisorUpdate, ClientError> {
    let current = client
        .read_session_thread(SessionThreadReadParams {
            session_id: session.clone(),
            thread_id: thread.clone(),
            history: None,
        })?
        .thread;
    let config = client.read_config()?;
    if argument.is_empty() {
        let resolved = current.advisor.resolve(config.advisor.as_ref());
        let label = resolved
            .as_ref()
            .map(|config| format!("{}/{}", config.model.provider, config.model.model))
            .unwrap_or_else(|| "off".into());
        let mut options = vec![
            ("No advisor".into(), "off".into()),
            ("Use saved default".into(), "default".into()),
            ("Save current selection as default".into(), "save".into()),
        ];
        options.extend(client.list_models()?.models.into_iter().map(|entry| {
            (
                entry.display_name,
                format!("{}/{}", entry.model.provider, entry.model.model),
            )
        }));
        let mut actions = BTreeMap::new();
        let items = options
            .into_iter()
            .map(|(label, preference): (String, String)| {
                let id = ListSelectionItemId::new(&preference);
                actions.insert(
                    id.clone(),
                    super::ModelSelectionAction::Advisor { preference },
                );
                ListSelectionItem::new(label).with_id(id)
            })
            .collect();
        return Ok(AdvisorUpdate::Picker(super::ModelChoices {
            model: ListSelectionModel::new(
                format!("Advisor: {label}"),
                vec![ListSelectionGroup::new("Models", items)],
            )
            .with_key_hint_note("Consultations use additional tokens"),
            actions,
        }));
    }
    if argument == "save" {
        let advisor = current.advisor.resolve(config.advisor.as_ref());
        client.update_config(ConfigUpdateParams {
            command_id: new_command_id("advisor-default"),
            expected_revision: config.revision,
            advisor: advisor.map(Patch::Value).unwrap_or(Patch::Null),
            time_context: Patch::Missing,
            features: Patch::Missing,
            model: Patch::Missing,
            model_reasoning_effort: Patch::Missing,
            commit_message_model: Patch::Missing,
            approval_review_model: Patch::Missing,
            tool_mode: Patch::Missing,
            grep_backend: Patch::Missing,
            git: Patch::Missing,
            gui: Patch::Missing,
            tui: Patch::Missing,
        })?;
        return Ok(AdvisorUpdate::Notice("Saved the advisor default".into()));
    }
    let selection = match argument {
        "off" => AdvisorSelection::Off,
        "default" => AdvisorSelection::Default,
        _ => {
            let entry = client
                .list_models()?
                .models
                .into_iter()
                .find(|entry| format!("{}/{}", entry.model.provider, entry.model.model) == argument)
                .ok_or_else(|| {
                    ClientError::Protocol("Select an available model with /advisor".into())
                })?;
            AdvisorSelection::Model {
                config: AdvisorConfig::new(entry.model),
            }
        }
    };
    match client.request_session(SessionRequestParams {
        command_id: new_command_id("advisor"),
        session_id: session.clone(),
        request: SessionRequest::ConfigureAdvisor {
            thread_id: thread.clone(),
            expected_sequence: current.sequence,
            selection,
        },
    })? {
        SessionRequestResult::AdvisorConfigured(_) => Ok(AdvisorUpdate::Notice(format!(
            "Advisor: {argument}. Use /advisor ask <question> for a second opinion."
        ))),
        _ => Err(ClientError::Protocol(
            "Expected advisor configuration result".into(),
        )),
    }
}
