use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use ash_protocol::ApprovalMode;
use ash_protocol::CollaborationMode;
use ash_protocol::ReasoningEffort;
use std::collections::BTreeMap;

pub(crate) const MODES: [CollaborationMode; 5] = [
    CollaborationMode::Agent,
    CollaborationMode::Plan,
    CollaborationMode::Debug,
    CollaborationMode::Multitask,
    CollaborationMode::Ask,
];

/// Composer selectors change the next submission; they never mutate an accepted Turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ComposerOption {
    Mode(CollaborationMode),
    Policy(ApprovalMode),
    Effort(ReasoningEffort),
}

pub(crate) type ComposerOptions = ListSelectionSpec<ComposerOption>;

pub(crate) const fn mode_label(mode: CollaborationMode) -> &'static str {
    match mode {
        CollaborationMode::Agent => "Agent",
        CollaborationMode::Plan => "Plan",
        CollaborationMode::Debug => "Debug",
        CollaborationMode::Multitask => "Multitask",
        CollaborationMode::Ask => "Ask",
    }
}

pub(crate) fn next_mode(mode: CollaborationMode) -> CollaborationMode {
    match mode {
        CollaborationMode::Agent => CollaborationMode::Plan,
        CollaborationMode::Plan => CollaborationMode::Debug,
        CollaborationMode::Debug => CollaborationMode::Multitask,
        CollaborationMode::Multitask => CollaborationMode::Ask,
        CollaborationMode::Ask => CollaborationMode::Agent,
    }
}

pub(crate) fn parse_mode(value: &str) -> Result<CollaborationMode, String> {
    // The protocol owns stable IDs; display labels and translations may change independently.
    serde_json::from_value(serde_json::Value::String(value.to_ascii_lowercase()))
        .map_err(|_| "Use /mode agent|plan|debug|multitask|ask".into())
}

pub(crate) fn mode_choices(current: CollaborationMode) -> ComposerOptions {
    choices(
        "Mode",
        MODES.into_iter().map(|mode| {
            let description = match mode {
                CollaborationMode::Agent => "Complete the task",
                CollaborationMode::Plan => "Analyze and plan without editing",
                CollaborationMode::Debug => "Investigate and fix a problem",
                CollaborationMode::Multitask => "Delegate work and combine results",
                CollaborationMode::Ask => "Answer questions without editing",
            };
            (
                mode_label(mode).into(),
                description.into(),
                ComposerOption::Mode(mode),
                mode == current,
            )
        }),
    )
}

pub(crate) fn policy_choices(current: ApprovalMode) -> ComposerOptions {
    choices(
        "Permissions",
        [
            (
                "Ask permissions",
                "ask-permissions",
                ApprovalMode::AskPermissions,
            ),
            ("Auto review", "auto-review", ApprovalMode::AutoReview),
            (
                "Bypass permissions",
                "bypass-permissions",
                ApprovalMode::BypassPermissions,
            ),
        ]
        .into_iter()
        .map(|(label, id, mode)| {
            (
                label.into(),
                id.into(),
                ComposerOption::Policy(mode),
                mode == current,
            )
        }),
    )
}

pub(crate) fn parse_policy(value: &str) -> Result<ApprovalMode, String> {
    match value {
        "ask-permissions" => Ok(ApprovalMode::AskPermissions),
        "auto-review" => Ok(ApprovalMode::AutoReview),
        "bypass-permissions" => Ok(ApprovalMode::BypassPermissions),
        _ => Err("Use /policy ask-permissions|auto-review|bypass-permissions".into()),
    }
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
