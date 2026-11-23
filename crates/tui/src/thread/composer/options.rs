use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use ash_protocol::AgentMode;
use ash_protocol::ApprovalMode;
use ash_protocol::ReasoningEffort;
use std::collections::BTreeMap;

pub(crate) const MODES: [AgentMode; 5] = [
    AgentMode::Agent,
    AgentMode::Plan,
    AgentMode::Debug,
    AgentMode::Multitask,
    AgentMode::Ask,
];

/// Composer selectors change the next submission; they never mutate an accepted Turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ComposerOption {
    Mode(AgentMode),
    Policy(ApprovalMode),
    Effort(ReasoningEffort),
}

pub(crate) type ComposerOptions = ListSelectionSpec<ComposerOption>;

pub(crate) const fn mode_label(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Agent => "Agent",
        AgentMode::Plan => "Plan",
        AgentMode::Debug => "Debug",
        AgentMode::Multitask => "Multitask",
        AgentMode::Ask => "Ask",
    }
}

pub(crate) fn next_mode(mode: AgentMode) -> AgentMode {
    match mode {
        AgentMode::Agent => AgentMode::Plan,
        AgentMode::Plan => AgentMode::Debug,
        AgentMode::Debug => AgentMode::Multitask,
        AgentMode::Multitask => AgentMode::Ask,
        AgentMode::Ask => AgentMode::Agent,
    }
}

pub(crate) fn parse_mode(value: &str) -> Result<AgentMode, String> {
    // The protocol owns stable IDs; display labels and translations may change independently.
    serde_json::from_value(serde_json::Value::String(value.to_ascii_lowercase()))
        .map_err(|_| "Use /mode agent|plan|debug|multitask|ask".into())
}

pub(crate) enum EffortSelection {
    Effort(ReasoningEffort),
    Mode(AgentMode),
}

pub(crate) fn parse_effort(
    value: &str,
    current_mode: AgentMode,
) -> Result<EffortSelection, String> {
    let mut arguments = value.split_whitespace();
    let selection = arguments.next().unwrap_or_default().to_ascii_lowercase();
    if selection == "multitask" {
        let mode = match arguments.next().map(str::to_ascii_lowercase).as_deref() {
            None | Some("on") => AgentMode::Multitask,
            Some("off") if current_mode == AgentMode::Multitask => AgentMode::Agent,
            Some("off") => current_mode,
            Some(_) => return Err(effort_usage().into()),
        };
        if arguments.next().is_some() {
            return Err(effort_usage().into());
        }
        return Ok(EffortSelection::Mode(mode));
    }
    if arguments.next().is_some() {
        return Err(effort_usage().into());
    }
    selection
        .parse()
        .map(EffortSelection::Effort)
        .map_err(|_| effort_usage().into())
}

fn effort_usage() -> &'static str {
    "Use /effort <level> or /effort multitask [on|off]"
}

pub(crate) fn mode_choices(current: AgentMode) -> ComposerOptions {
    choices(
        "Mode",
        MODES.into_iter().map(|mode| {
            let description = match mode {
                AgentMode::Agent => "Complete the task",
                AgentMode::Plan => "Analyze and plan without editing",
                AgentMode::Debug => "Investigate and fix a problem",
                AgentMode::Multitask => "Ash delegates and combines results",
                AgentMode::Ask => "Answer questions without editing",
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
