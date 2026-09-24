use crate::keymap::KeymapActionSnapshot;
use crate::keymap::fixed_bindings;
use crate::thread::composer::SlashCommandCatalog;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::search_box::SearchBoxModel;
use ash_slash_commands::SlashCommandOrigin;

pub(crate) fn help_choices(
    slash_commands: &SlashCommandCatalog,
    shortcut_actions: Vec<KeymapActionSnapshot>,
) -> ListSelectionModel {
    let mut commands = Vec::new();
    let mut custom_commands = Vec::new();
    for command in slash_commands.commands() {
        let item = ListSelectionItem::new(format!("/{}", command.name))
            .with_description(&command.description);
        match slash_commands
            .origin(&command.name)
            .expect("every catalog command has an origin")
        {
            SlashCommandOrigin::Local => commands.push(item),
            SlashCommandOrigin::Server => custom_commands.push(item),
        }
    }

    ListSelectionModel::new(
        "Help",
        vec![
            ListSelectionGroup::new("Shortcuts", shortcut_items(shortcut_actions)),
            ListSelectionGroup::new("Commands", commands),
            ListSelectionGroup::new(
                "Custom commands",
                non_empty(custom_commands, "No custom commands available"),
            ),
        ],
    )
    .with_search(SearchBoxModel::new("Search help"))
    .with_empty_message("No matching help entries")
}

fn shortcut_items(actions: Vec<KeymapActionSnapshot>) -> Vec<ListSelectionItem> {
    let mut items = Vec::new();
    for action in actions {
        for key in action.default_bindings {
            items.push(ListSelectionItem::new(key).with_description(action.label));
        }
        for binding in action.user_bindings {
            let description = match binding.when {
                Some(condition) => format!("{} when {condition} · custom", action.label),
                None => format!("{} · custom", action.label),
            };
            items.push(ListSelectionItem::new(binding.key).with_description(description));
        }
    }
    items.extend(
        fixed_bindings()
            .map(|(key, description)| ListSelectionItem::new(key).with_description(description)),
    );
    items
}

fn non_empty(items: Vec<ListSelectionItem>, label: &str) -> Vec<ListSelectionItem> {
    if items.is_empty() {
        vec![ListSelectionItem::new(label)]
    } else {
        items
    }
}
