use crate::nls::Text;
use crate::thread::composer::TuiSlashCommandAction;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;

/// The management tabs share navigation while each feature owns its operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Tab {
    Skills,
    Marketplace,
    Mcp,
    Hooks,
    Plugins,
}

impl Tab {
    pub(crate) const ALL: [Self; 5] = [
        Self::Skills,
        Self::Marketplace,
        Self::Mcp,
        Self::Hooks,
        Self::Plugins,
    ];

    pub(crate) fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap()
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Skills => "Skills",
            Self::Marketplace => "Marketplace",
            Self::Mcp => "MCP",
            Self::Hooks => "Hooks",
            Self::Plugins => "Plugins",
        }
    }

    pub(crate) fn command(self) -> TuiSlashCommandAction {
        match self {
            Self::Skills => TuiSlashCommandAction::Skills,
            Self::Marketplace => TuiSlashCommandAction::Marketplace,
            Self::Mcp => TuiSlashCommandAction::Mcp,
            Self::Hooks => TuiSlashCommandAction::Hooks,
            Self::Plugins => TuiSlashCommandAction::Plugins,
        }
    }
}

pub(crate) fn model(tab: Tab, mut items: Vec<ListSelectionItem>) -> ListSelectionModel {
    let groups = Tab::ALL
        .into_iter()
        .map(|entry| {
            ListSelectionGroup::new(
                entry.label(),
                if entry == tab {
                    std::mem::take(&mut items)
                } else {
                    Vec::new()
                },
            )
        })
        .collect();
    ListSelectionModel::new("Extensions", groups).with_initial_tab(tab.index())
}

pub(crate) fn title(name: &str, enabled: bool) -> Text {
    if enabled {
        Text::literal(name)
    } else {
        Text::template("{0} [disable]", vec![Text::literal(name)])
    }
}
