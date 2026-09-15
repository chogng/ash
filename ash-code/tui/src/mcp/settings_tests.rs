use super::McpSelectionAction;
use super::mcp_choices;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_protocol::protocol::config::McpCredentialBindingDto;
use ash_app_server_protocol::protocol::config::McpServerConfigDto;
use ash_app_server_protocol::protocol::config::McpServerEnablementDto;
use ash_app_server_protocol::protocol::config::McpTransportDto;
use std::collections::BTreeMap;

#[test]
fn mcp_settings_filter_servers_and_maps_enter_to_the_opposite_enablement() {
    let mut servers = BTreeMap::new();
    servers.insert(
        "docs".into(),
        McpServerConfigDto {
            id: "docs".into(),
            display_name: "Documentation".into(),
            transport: McpTransportDto::Stdio {
                command: "docs-server".into(),
                args: vec!["--stdio".into()],
            },
            credential: McpCredentialBindingDto::Unauthenticated,
            enablement: McpServerEnablementDto::Enabled,
        },
    );

    let view = mcp_choices(&servers);
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "MCP servers");
    assert_eq!(state.tabs()[0].label(), "All (1)");
    assert_eq!(state.visible_items()[0].label(), "Documentation");
    assert_eq!(
        view.actions.values().next(),
        Some(&McpSelectionAction::SetEnablement {
            server_id: "docs".into(),
            enablement: McpServerEnablementDto::Disabled,
        })
    );
}
