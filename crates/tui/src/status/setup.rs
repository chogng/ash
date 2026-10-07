use crate::keymap::bindings;
use std::collections::BTreeMap;

use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;

use super::StatusLineEdit;
use super::StatusLineItem;
use super::StatusLineSettings;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StatusLineSelectionAction {
    SetEnabled(StatusLineEdit),
}

pub(crate) type StatusLineChoices = ListSelectionSpec<StatusLineSelectionAction>;

pub(crate) fn list_selection(settings: &StatusLineSettings, revision: u64) -> StatusLineChoices {
    let mut actions = BTreeMap::new();
    let items = StatusLineItem::ALL
        .into_iter()
        .map(|item| {
            let enabled = settings.enabled(item);
            let id = ListSelectionItemId::new(item.id());
            actions.insert(
                id.clone(),
                StatusLineSelectionAction::SetEnabled(StatusLineEdit {
                    expected_revision: revision,
                    item,
                    enabled: !enabled,
                }),
            );
            ListSelectionItem::new(item.label())
                .with_id(id)
                .with_columns(item.label(), item.description(), switch_value(enabled))
        })
        .collect();
    let model = ListSelectionModel::new(
        "Status line",
        vec![ListSelectionGroup::new("Status line", items)],
    )
    .without_tab_bar()
    .with_expandable_descriptions()
    .with_activation(bindings::STATUS_TOGGLE);
    StatusLineChoices { model, actions }
}

const fn switch_value(checked: bool) -> &'static str {
    if checked { "on" } else { "off" }
}

#[cfg(test)]
#[path = "setup_tests.rs"]
mod tests;
