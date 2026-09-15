use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::config::McpServerConfigDto;
use ash_app_server_protocol::protocol::config::McpServerEnablementDto;
use ash_app_server_protocol::protocol::config::McpTransportDto;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum McpSelectionAction {
    SetEnablement {
        server_id: String,
        enablement: McpServerEnablementDto,
    },
}

pub(crate) type McpChoices = ListSelectionSpec<McpSelectionAction>;

pub(crate) fn mcp_choices(servers: &BTreeMap<String, McpServerConfigDto>) -> McpChoices {
    let mut actions = BTreeMap::new();
    let all = servers
        .values()
        .enumerate()
        .map(|(index, server)| mcp_item(index, server, &mut actions))
        .collect::<Vec<_>>();
    let enabled = all
        .iter()
        .zip(servers.values())
        .filter(|(_, server)| server.enablement == McpServerEnablementDto::Enabled)
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let disabled = all
        .iter()
        .zip(servers.values())
        .filter(|(_, server)| server.enablement == McpServerEnablementDto::Disabled)
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let enabled_count = enabled.len();
    let disabled_count = disabled.len();

    McpChoices {
        model: ListSelectionModel::new(
            "MCP servers",
            vec![
                ListSelectionGroup::new(format!("All ({})", all.len()), all),
                ListSelectionGroup::new(format!("Enabled ({enabled_count})"), enabled),
                ListSelectionGroup::new(format!("Disabled ({disabled_count})"), disabled),
            ],
        )
        .with_activation(bindings::MCP_TOGGLE)
        .with_search(SearchBoxModel::new("Search MCP servers"))
        .with_empty_message("No matching MCP servers"),
        actions,
    }
}

fn mcp_item(
    index: usize,
    server: &McpServerConfigDto,
    actions: &mut BTreeMap<ListSelectionItemId, McpSelectionAction>,
) -> ListSelectionItem {
    let item_id = ListSelectionItemId::new(format!("mcp-{index}"));
    let next_enablement = match server.enablement {
        McpServerEnablementDto::Disabled => McpServerEnablementDto::Enabled,
        McpServerEnablementDto::Enabled => McpServerEnablementDto::Disabled,
    };
    actions.insert(
        item_id.clone(),
        McpSelectionAction::SetEnablement {
            server_id: server.id.clone(),
            enablement: next_enablement,
        },
    );
    ListSelectionItem::new(&server.display_name)
        .with_id(item_id)
        .with_description(format!(
            "{}  ·  {}  ·  {}",
            server.id,
            enablement_label(server.enablement),
            transport_label(&server.transport)
        ))
}

fn enablement_label(enablement: McpServerEnablementDto) -> &'static str {
    match enablement {
        McpServerEnablementDto::Disabled => "disabled",
        McpServerEnablementDto::Enabled => "enabled",
    }
}

fn transport_label(transport: &McpTransportDto) -> String {
    match transport {
        McpTransportDto::Stdio { command, args } => std::iter::once(command.as_str())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        McpTransportDto::StreamableHttp { url } => url.clone(),
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
