use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use std::collections::BTreeMap;
use ash_protocol::Thread;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RewindSelectionAction {
    RestoreMessage {
        item_id: ash_protocol::ItemId,
        boundary: ash_protocol::MessageBoundary,
        checkpoint_label: String,
    },
    Rewind {
        before_turn_id: TurnId,
        checkpoint_label: String,
    },
}

pub(crate) type RewindChoices = ListSelectionSpec<RewindSelectionAction>;

pub(crate) fn rewind_choices(
    thread: &Thread,
    points: &[ash_protocol::MessageCheckpoint],
) -> RewindChoices {
    let checkpoints = thread
        .turns
        .iter()
        .filter_map(|turn| checkpoint_text(&turn.items).map(|text| (turn, text)))
        .filter(|(turn, _)| !points.iter().any(|point| point.turn_id == turn.turn_id))
        .collect::<Vec<_>>();
    let mut actions = BTreeMap::new();
    let mut items = checkpoints
        .iter()
        .enumerate()
        .map(|(index, (turn, text))| {
            let item_id = ListSelectionItemId::new(format!("rewind-{index}"));
            let checkpoint_label = compact_label(text);
            actions.insert(
                item_id.clone(),
                RewindSelectionAction::Rewind {
                    before_turn_id: turn.turn_id.clone(),
                    checkpoint_label: checkpoint_label.clone(),
                },
            );
            ListSelectionItem::new(format!("{}. {checkpoint_label}", index + 1))
                .with_id(item_id)
                .with_description("restore before this turn; keep the original branch")
        })
        .collect::<Vec<_>>();
    for item in thread.turns.iter().flat_map(|turn| &turn.items) {
        let Some(point) = points.iter().find(|point| &point.item_id == item.item_id()) else {
            continue;
        };
        let label = message_label(item);
        if let ash_protocol::WorkspaceCheckpoint::Unavailable { reason } = &point.workspace {
            items.push(
                ListSelectionItem::new(format!("Unavailable: {label}")).with_description(reason),
            );
            continue;
        }
        for (boundary, side) in [
            (ash_protocol::MessageBoundary::Before, "Before"),
            (ash_protocol::MessageBoundary::After, "After"),
        ] {
            let id = ListSelectionItemId::new(format!("message:{side}:{}", point.item_id));
            actions.insert(
                id.clone(),
                RewindSelectionAction::RestoreMessage {
                    item_id: point.item_id.clone(),
                    boundary,
                    checkpoint_label: label.clone(),
                },
            );
            items.push(ListSelectionItem::new(format!("{side} {label}")).with_id(id));
        }
    }
    let selected = items
        .iter()
        .rposition(|item| item.id().is_some())
        .unwrap_or(0);

    RewindChoices {
        model: ListSelectionModel::new(
            "Rewind",
            vec![ListSelectionGroup::new("Checkpoints", items)],
        )
        .with_activation(bindings::REWIND)
        .without_tab_bar()
        .with_initial_selected(selected)
        .with_search(SearchBoxModel::new("Search message checkpoints"))
        .with_empty_message("No message checkpoints available"),
        actions,
    }
}

fn message_label(item: &ThreadItem) -> String {
    if let ThreadItem::UserInstruction { reference, .. } = item {
        return format!("instruction: {}", reference.relative_path.display());
    }
    let (kind, text) = match item {
        ThreadItem::UserMessage { text, .. } => ("user", text.as_str()),
        ThreadItem::UserContext { content, .. } => ("context", content.as_str()),
        ThreadItem::UserImage { .. } | ThreadItem::UserImageAttachment { .. } => {
            ("user", "[Image]")
        }
        ThreadItem::AgentMessage { text, .. } => ("assistant", text.as_str()),
        ThreadItem::Reasoning { text, .. } => ("reasoning", text.as_str()),
        ThreadItem::Plan { text, .. } => ("plan", text.as_str()),
        ThreadItem::ToolCall { name, .. } => ("tool call", name.as_str()),
        ThreadItem::ToolResult { text, .. } => ("tool result", text.as_str()),
        ThreadItem::UserInstruction { .. } => unreachable!("handled above"),
    };
    format!("{kind}: {}", compact_label(text))
}

fn checkpoint_text(items: &[ThreadItem]) -> Option<String> {
    let parts = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::UserMessage { text, .. } => Some(text.as_str()),
            ThreadItem::UserContext { content, .. } => Some(content.as_str()),
            ThreadItem::UserInstruction { .. } => None,
            ThreadItem::UserImage { .. } | ThreadItem::UserImageAttachment { .. } => {
                Some("[Image]")
            }
            ThreadItem::AgentMessage { .. }
            | ThreadItem::Reasoning { .. }
            | ThreadItem::Plan { .. }
            | ThreadItem::ToolCall { .. }
            | ThreadItem::ToolResult { .. } => None,
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn compact_label(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut characters = normalized.chars();
    let label = characters.by_ref().take(96).collect::<String>();
    if characters.next().is_some() {
        format!("{label}…")
    } else {
        label
    }
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
