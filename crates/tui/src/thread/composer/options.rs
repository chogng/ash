use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use ash_protocol::ApprovalMode;
use ash_protocol::ReasoningEffort;
use std::collections::BTreeMap;

/// Composer selectors change the next submission; they never mutate an accepted Turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ComposerOption {
    Policy(ApprovalMode),
    Effort(ReasoningEffort),
}

pub(crate) type ComposerOptions = ListSelectionSpec<ComposerOption>;

pub(crate) fn parse_effort(value: &str) -> Result<ReasoningEffort, String> {
    value.parse().map_err(|_| "Use /effort <level>".into())
}

pub(crate) fn policy_choices(current: ApprovalMode) -> ComposerOptions {
    let mut items = Vec::new();
    let mut actions = BTreeMap::new();
    let mut selected = 0;
    for (index, mode) in ApprovalMode::ALL.into_iter().enumerate() {
        let definition = mode.definition();
        let id = ListSelectionItemId::new(mode.id());
        if mode == current {
            selected = index;
        }
        items.push(
            ListSelectionItem::new(definition.label.english)
                .with_columns(
                    definition.label.english,
                    definition.description.english,
                    if mode == current { "Current" } else { "" },
                )
                .with_details(definition.description.english)
                .with_id(id.clone()),
        );
        actions.insert(id, ComposerOption::Policy(mode));
    }
    ComposerOptions {
        model: ListSelectionModel::new("Permissions", vec![ListSelectionGroup::new("", items)])
            .without_tab_bar()
            .with_expandable_descriptions()
            .with_initial_selected(selected),
        actions,
    }
}

pub(crate) fn parse_policy(value: &str) -> Result<ApprovalMode, String> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|_| "Use /permission manual|auto|bypassPermissions".into())
}

pub(crate) fn choices(
    title: &str,
    options: impl IntoIterator<Item = (String, String, ComposerOption, bool)>,
) -> ComposerOptions {
    let mut items = Vec::new();
    let mut actions = BTreeMap::new();
    let mut initial_selected = 0;
    for (index, (label, description, action, selected)) in options.into_iter().enumerate() {
        let id = ListSelectionItemId::new(index.to_string());
        if selected {
            initial_selected = index;
        }
        items.push(
            ListSelectionItem::new(label.clone())
                .with_columns(label, description, if selected { "Current" } else { "" })
                .with_id(id.clone()),
        );
        actions.insert(id, action);
    }
    ComposerOptions {
        model: ListSelectionModel::new(title, vec![ListSelectionGroup::new("", items)])
            .without_tab_bar()
            .with_initial_selected(initial_selected),
        actions,
    }
}
