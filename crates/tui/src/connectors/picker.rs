use crate::keymap::bindings;
use std::collections::BTreeMap;

use ash_app_server_protocol::protocol::connectors::ConnectorAvailableActionDto;
use ash_app_server_protocol::protocol::connectors::ConnectorConnectionStateDto;
use ash_app_server_protocol::protocol::connectors::ConnectorDto;
use ash_app_server_protocol::protocol::connectors::ConnectorListResult;

use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ConnectorSelectionAction {
    Marketplace,
    ConnectDeviceOAuth {
        connector_id: String,
        connection_generation: u64,
    },
    Disconnect {
        connector_id: String,
    },
}

pub(crate) type ConnectorChoices = ListSelectionSpec<ConnectorSelectionAction>;

pub(crate) fn connector_choices(catalog: &ConnectorListResult) -> ConnectorChoices {
    let mut actions = BTreeMap::new();
    let marketplace_id = ListSelectionItemId::new("marketplace");
    actions.insert(
        marketplace_id.clone(),
        ConnectorSelectionAction::Marketplace,
    );
    let all = catalog
        .connectors
        .iter()
        .enumerate()
        .map(|(index, connector)| connector_item(index, connector, &mut actions))
        .collect::<Vec<_>>();
    let connected = all
        .iter()
        .zip(&catalog.connectors)
        .filter(|(_, connector)| {
            matches!(
                connector.state,
                ConnectorConnectionStateDto::Connected { .. }
            )
        })
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let disconnected = all
        .iter()
        .zip(&catalog.connectors)
        .filter(|(_, connector)| {
            !matches!(
                connector.state,
                ConnectorConnectionStateDto::Connected { .. }
            )
        })
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    ConnectorChoices {
        model: ListSelectionModel::new(
            "Connectors",
            vec![
                ListSelectionGroup::new(format!("All ({})", all.len()), all),
                ListSelectionGroup::new(format!("Connected ({})", connected.len()), connected),
                ListSelectionGroup::new(
                    format!("Not connected ({})", disconnected.len()),
                    disconnected,
                ),
            ],
        )
        .with_activation(bindings::CONNECTOR_TOGGLE)
        .with_action(ListSelectionItem::new("Get connectors").with_id(marketplace_id))
        .with_search(SearchBoxModel::new("Search connectors"))
        .with_empty_message("No matching Connectors"),
        actions,
    }
}

fn connector_item(
    index: usize,
    connector: &ConnectorDto,
    actions: &mut BTreeMap<ListSelectionItemId, ConnectorSelectionAction>,
) -> ListSelectionItem {
    let item_id = ListSelectionItemId::new(format!("connector-{index}"));
    if connector
        .available_actions
        .contains(&ConnectorAvailableActionDto::Disconnect)
    {
        actions.insert(
            item_id.clone(),
            ConnectorSelectionAction::Disconnect {
                connector_id: connector.id.clone(),
            },
        );
    } else if connector.available_actions.iter().any(|action| {
        matches!(
            action,
            ConnectorAvailableActionDto::ConnectOAuth
                | ConnectorAvailableActionDto::ReauthorizeOAuth
        )
    }) && connector
        .oauth_methods
        .contains(&ash_app_server_protocol::protocol::connectors::ConnectorOAuthMethodDto::Device)
    {
        actions.insert(
            item_id.clone(),
            ConnectorSelectionAction::ConnectDeviceOAuth {
                connector_id: connector.id.clone(),
                connection_generation: connector.connection_generation + 1,
            },
        );
    }
    ListSelectionItem::new(&connector.display_name)
        .with_id(item_id)
        .with_description(format!(
            "{}  ·  {}",
            connector.description,
            state_label(&connector.state)
        ))
}

fn state_label(state: &ConnectorConnectionStateDto) -> String {
    match state {
        ConnectorConnectionStateDto::Disconnected => "not connected".into(),
        ConnectorConnectionStateDto::Connecting => "connecting".into(),
        ConnectorConnectionStateDto::Connected { account } => {
            format!("connected as {}", account.display_name)
        }
        ConnectorConnectionStateDto::Unavailable { reason } => format!("unavailable: {reason}"),
        ConnectorConnectionStateDto::ReauthorizationRequired { account, .. } => {
            format!("reconnect {}", account.display_name)
        }
    }
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
